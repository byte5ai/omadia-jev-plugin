import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildRequestBody,
  createJevClient,
  effectiveModel,
  endpointUrl,
  errorReason,
  JevError,
  parseChoiceAnswer,
  retryAfterMs,
} from '../src/jevClient.js';
import { activate, DEFAULT_MODEL } from '../src/plugin.js';
import { BREAKER_COOLDOWN_MS, BREAKER_FAILURES, createJevDecisionService, parseTasks } from '../src/service.js';
import type { DecisionChoiceRequest, DecisionModelService } from '../src/contract.js';

const REQ: DecisionChoiceRequest = {
  task: 'fast-path.gate',
  instruction: 'Does answering the USER TURN need a language model?',
  input: 'USER TURN: offene Posten von «PERSON_1»',
  options: [
    { id: 'data', description: 'no model' },
    { id: 'model_simple', description: 'model, simple' },
    { id: 'model_complex', description: 'model, complex' },
  ],
};

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: { decision: { type: 'choice', choice: 'data', probabilities: { data: 0.93, model_simple: 0.02, model_complex: 0.05 }, confidence: 0.93 } },
  usage: { input_tokens: 80, output_tokens: 0 },
};

function fakeFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    }) as typeof fetch,
  };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('System One mapping', () => {
  it('one choice question: state = input, criteria = {id: description}, pinned model', () => {
    assert.deepEqual(buildRequestBody(REQ, 'jev/jev-1.13.0'), {
      model: 'jev/jev-1.13.0',
      state: REQ.input,
      questions: {
        decision: {
          type: 'choice',
          instructions: REQ.instruction,
          criteria: { data: 'no model', model_simple: 'model, simple', model_complex: 'model, complex' },
        },
      },
    });
  });

  it('the direct API gets TypeSafe model names; a gateway keeps its prefix', () => {
    assert.equal(effectiveModel('https://api.typesafe.ai', 'jev/jev-1.13.0'), 'jev-1.13.0');
    assert.equal(effectiveModel('https://api.typesafe.ai/v1', 'jev-latest'), 'jev-latest');
    assert.equal(effectiveModel('https://openrouter.ai/api', 'jev/jev-1.13.0'), 'jev/jev-1.13.0');
    assert.equal(DEFAULT_MODEL, 'jev-1.14.0');
  });

  it('4xx reasons are content-free: error_type or field paths, never message text', () => {
    assert.equal(errorReason({ detail: { error_type: 'invalid_model', message: 'echo USER TURN' } }), 'invalid_model');
    assert.equal(errorReason({ detail: [{ loc: ['body', 'questions', 'decision', 'criteria'], msg: 'USER TURN' }] }), 'invalid body.questions.decision.criteria');
    assert.equal(errorReason({ detail: 'free text USER TURN' }), undefined);
  });

  it('endpoint with or without /v1 and trailing slashes', () => {
    assert.equal(endpointUrl('https://api.typesafe.ai'), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(endpointUrl('https://gw.example.com/v1/'), 'https://gw.example.com/v1/systemone');
  });

  it('parses choice, confidence, probabilities (known ids only) and model', () => {
    const body = { ...OK_BODY, answers: { decision: { ...OK_BODY.answers.decision, probabilities: { data: 0.93, rogue: 1 } } } };
    assert.deepEqual(parseChoiceAnswer(REQ, body), {
      choice: 'data',
      confidence: 0.93,
      probabilities: { data: 0.93 },
      model: 'jev-1.13.0',
    });
  });

  it('confidence falls back to the chosen probability; out-of-range values are clamped', () => {
    const r = parseChoiceAnswer(REQ, { answers: { decision: { choice: 'model_complex', probabilities: { model_complex: 1.2 } } } });
    assert.equal(r.confidence, 1);
  });

  it('refuses an unknown choice, a missing answer or a missing confidence', () => {
    assert.throws(() => parseChoiceAnswer(REQ, { answers: { decision: { choice: 'maybe', confidence: 0.9 } } }), JevError);
    assert.throws(() => parseChoiceAnswer(REQ, { answers: {} }), JevError);
    assert.throws(() => parseChoiceAnswer(REQ, { answers: { decision: { choice: 'data' } } }), JevError);
  });

  it('retry-after in seconds or as an HTTP date', () => {
    assert.equal(retryAfterMs('7'), 7000);
    assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(retryAfterMs(null), undefined);
  });
});

describe('Jev client', () => {
  it('POSTs with the bearer key and returns the decision with its cost', async () => {
    const f = fakeFetch(() => json(OK_BODY, { headers: { 'x-cost-usd': '0.0000034' } }));
    const client = createJevClient({ baseUrl: 'https://api.typesafe.ai', apiKey: 'k-123', model: DEFAULT_MODEL, timeoutMs: 1000, fetch: f.fetch });
    const out = await client.choose(REQ);
    assert.equal(out.choice, 'data');
    assert.equal(out.costUsd, 0.0000034);
    assert.equal(f.calls[0]?.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(f.calls[0]?.init.method, 'POST');
    assert.equal((f.calls[0]?.init.headers as Record<string, string>)['Authorization'], 'Bearer k-123');
  });

  it('an HTTP error never echoes the body; 429 carries retry-after', async () => {
    const f = fakeFetch(() => new Response('{"detail":"echo USER TURN"}', { status: 429, headers: { 'retry-after': '5' } }));
    const client = createJevClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm', timeoutMs: 1000, fetch: f.fetch });
    await assert.rejects(client.choose(REQ), (err: unknown) => {
      assert.ok(err instanceof JevError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 5000);
      assert.doesNotMatch(err.message, /USER TURN/);
      return true;
    });
  });

  it('aborts at its own timeout', async () => {
    const f = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createJevClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm', timeoutMs: 20, fetch: f.fetch });
    // AbortSignal.timeout is unref'd — keep the loop alive like a server does
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(client.choose(REQ), JevError);
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe('decision service — task filter and circuit breaker', () => {
  it('parseTasks: all/empty → everything; a list → only those', () => {
    assert.equal(parseTasks('all')('x'), true);
    assert.equal(parseTasks('')('x'), true);
    const only = parseTasks('fast-path.gate, fast-path.source');
    assert.equal(only('fast-path.gate'), true);
    assert.equal(only('fast-path.direct-plan'), false);
  });

  it('a task not enabled is refused without a call', async () => {
    let calls = 0;
    const svc = createJevDecisionService({
      client: { choose: async () => (calls++, { choice: 'data', confidence: 0.9 }) },
      tasks: 'fast-path.gate',
      log: () => {},
    });
    await assert.rejects(svc.choose({ ...REQ, task: 'fast-path.source' }), /not enabled/);
    assert.equal(calls, 0);
    assert.equal((await svc.choose(REQ)).choice, 'data');
  });

  it('opens after consecutive failures, refuses during the cool-down, closes after it', async () => {
    let t = 0;
    let calls = 0;
    const logs: string[] = [];
    const svc = createJevDecisionService({
      client: {
        choose: async () => {
          calls++;
          throw new JevError('HTTP 529', 529);
        },
      },
      tasks: 'all',
      log: (m) => logs.push(m),
      now: () => t,
    });
    for (let i = 0; i < BREAKER_FAILURES; i++) await assert.rejects(svc.choose(REQ));
    await assert.rejects(svc.choose(REQ), /circuit open/);
    assert.equal(calls, BREAKER_FAILURES);
    t += BREAKER_COOLDOWN_MS + 1;
    await assert.rejects(svc.choose(REQ), /HTTP 529/);
    assert.equal(calls, BREAKER_FAILURES + 1);
    assert.ok(logs.some((m) => m.includes('breaker open')));
  });

  it('a 429 opens the breaker for its retry-after at once', async () => {
    let t = 0;
    const svc = createJevDecisionService({
      client: { choose: async () => { throw new JevError('HTTP 429', 429, 4000); } },
      tasks: 'all',
      log: () => {},
      now: () => t,
    });
    await assert.rejects(svc.choose(REQ), /HTTP 429/);
    await assert.rejects(svc.choose(REQ), /circuit open/);
    t += 4001;
    await assert.rejects(svc.choose(REQ), /HTTP 429/);
  });

  it('logs task, choice, confidence and cost — never the input', async () => {
    const logs: string[] = [];
    const svc = createJevDecisionService({
      client: { choose: async () => ({ choice: 'data', confidence: 0.93, model: 'jev-1.13.0', costUsd: 0.000003 }) },
      tasks: 'all',
      log: (m) => logs.push(m),
    });
    const out = await svc.choose(REQ);
    assert.deepEqual(out, { choice: 'data', confidence: 0.93, model: 'jev-1.13.0' }, 'no cost on the contract result');
    assert.match(logs[0] ?? '', /task=fast-path\.gate choice=data conf=0\.93 ms=\d+ model=jev-1\.13\.0 cost_usd=0\.000003/);
    assert.doesNotMatch(logs.join('\n'), /PERSON_1|offene Posten/);
  });
});

describe('activation', () => {
  function ctx(secret: string | undefined, config: Record<string, unknown> = {}) {
    const provided: Array<{ name: string; impl: unknown }> = [];
    const logs: string[] = [];
    return {
      provided,
      logs,
      ctx: {
        log: (m: string) => logs.push(m),
        secrets: { get: async () => secret },
        config: { get: <T>(k: string): T | undefined => config[k] as T | undefined },
        services: {
          provide: <T>(name: string, impl: T) => {
            provided.push({ name, impl });
            return () => {};
          },
        },
      },
    };
  }

  it('without a key: active, nothing published', async () => {
    const c = ctx(undefined);
    await activate(c.ctx);
    assert.equal(c.provided.length, 0);
    assert.match(c.logs[0] ?? '', /no jev_api_key/);
  });

  async function withModels<T>(names: string[], run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 })) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it('with a key: publishes decisionModel with provider jev; the key is never logged', async () => {
    const c = ctx('secret-key-123', { jev_tasks: 'fast-path.gate' });
    await withModels(['jev-latest', 'jev-1.14.0'], async () => {
      await activate(c.ctx);
      await settle();
    });
    assert.equal(c.provided[0]?.name, 'decisionModel');
    assert.equal((c.provided[0]?.impl as DecisionModelService).provider, 'jev');
    assert.match(c.logs[0] ?? '', /model=jev-1\.14\.0 .* tasks=fast-path\.gate/);
    assert.ok(c.logs.some((m) => m.includes('model jev-1.14.0 available')));
    assert.doesNotMatch(c.logs.join('\n'), /secret-key-123/);
  });

  it('a stored gateway-style model name is corrected; an unknown one is warned about at activation', async () => {
    const legacy = ctx('k', { jev_model: 'jev/jev-1.13.0' });
    await withModels(['jev-1.13.0'], async () => {
      await activate(legacy.ctx);
      await settle();
    });
    assert.match(legacy.logs[0] ?? '', /model=jev-1\.13\.0 /);
    const unknown = ctx('k', { jev_model: 'jev-9.9.9' });
    await withModels(['jev-latest', 'jev-1.14.0'], async () => {
      await activate(unknown.ctx);
      await settle();
    });
    assert.ok(unknown.logs.some((m) => /WARNING model jev-9\.9\.9 is not available .* jev-latest, jev-1\.14\.0/.test(m)));
  });
});
