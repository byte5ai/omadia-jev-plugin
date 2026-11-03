import type {
  DecisionAnswer,
  DecisionBatchRequest,
  DecisionBatchResult,
  DecisionChoiceRequest,
  DecisionChoiceResult,
} from './contract.js';

/**
 * TypeSafe Jev — System One HTTP API (`POST {base}/v1/systemone`).
 *
 * One `choice` question per call: the request's input is the `state`, its
 * options become the question's `criteria` (`{ id: description }`). The
 * answer's choice is validated against the requested ids; anything else is
 * an error, so the caller (the fast path) falls back to its LLM router.
 */

export const QUESTION_KEY = 'decision';

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** ms to wait before the next call (429 `retry-after`) */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export interface JevClientOptions {
  baseUrl: string;
  apiKey: string;
  /** a name, or a getter — the activation check may switch it later */
  model: string | (() => string);
  timeoutMs: number;
  /** test seam */
  fetch?: typeof fetch;
}

export interface JevCallResult extends DecisionChoiceResult {
  /** `X-Cost-USD` of the call, when the API reports it */
  costUsd?: number;
}

/** The System One request body of one choice question. */
export function buildRequestBody(req: DecisionChoiceRequest, model: string): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const o of req.options) criteria[o.id] = o.description;
  return {
    model,
    state: req.input,
    questions: { [QUESTION_KEY]: { type: 'choice', instructions: req.instruction, criteria } },
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** The System One body of a batch: `choice` → Choice, `yesno` → Noul. */
export function buildBatchBody(req: DecisionBatchRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.kind === 'yesno') {
      questions[id] = { type: 'noul', instructions: q.instruction };
    } else {
      const criteria: Record<string, string> = {};
      for (const o of q.options) criteria[o.id] = o.description;
      questions[id] = { type: 'choice', instructions: q.instruction, criteria };
    }
  }
  return { model, state: req.input, questions };
}

/** The answers of a batch response, each validated against its question;
 *  an invalid or missing answer is left out (the caller decides without it). */
export function parseBatchAnswers(req: Pick<DecisionBatchRequest, 'questions'>, body: unknown): DecisionBatchResult {
  const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const answers = typeof root['answers'] === 'object' && root['answers'] !== null ? (root['answers'] as Record<string, unknown>) : {};
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const a = answers[id];
    if (typeof a !== 'object' || a === null) continue;
    if (q.kind === 'yesno') {
      const p = (a as Record<string, unknown>)['noul'];
      if (typeof p === 'number' && Number.isFinite(p)) out[id] = { kind: 'yesno', probability: clamp01(p) };
      continue;
    }
    try {
      const c = parseChoiceAnswer(q, { answers: { [QUESTION_KEY]: a } });
      out[id] = { kind: 'choice', choice: c.choice, confidence: c.confidence, ...(c.probabilities ? { probabilities: c.probabilities } : {}) };
    } catch {
      // an invalid choice answer is dropped, never guessed
    }
  }
  const model = root['model'];
  return { answers: out, ...(typeof model === 'string' && model.length > 0 ? { model } : {}) };
}

/** The choice answer of a System One response, validated against `req`. */
export function parseChoiceAnswer(req: Pick<DecisionChoiceRequest, 'options'>, body: unknown): DecisionChoiceResult {
  const ids = new Set(req.options.map((o) => o.id));
  const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const answers = root['answers'];
  const answer =
    typeof answers === 'object' && answers !== null ? (answers as Record<string, unknown>)[QUESTION_KEY] : undefined;
  if (typeof answer !== 'object' || answer === null) throw new JevError('response without a choice answer');
  const a = answer as Record<string, unknown>;
  const choice = a['choice'];
  if (typeof choice !== 'string' || !ids.has(choice)) throw new JevError('choice is not one of the requested options');
  const rawProbs = a['probabilities'];
  const probabilities: Record<string, number> = {};
  if (typeof rawProbs === 'object' && rawProbs !== null && !Array.isArray(rawProbs)) {
    for (const [id, p] of Object.entries(rawProbs as Record<string, unknown>)) {
      if (ids.has(id) && typeof p === 'number' && Number.isFinite(p)) probabilities[id] = clamp01(p);
    }
  }
  const rawConfidence = a['confidence'];
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? clamp01(rawConfidence)
      : probabilities[choice];
  if (confidence === undefined) throw new JevError('answer without a confidence');
  const model = root['model'];
  return {
    choice,
    confidence,
    ...(Object.keys(probabilities).length > 0 ? { probabilities } : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
  };
}

/** `retry-after` (seconds or HTTP date) in ms. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function apiBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The System One endpoint for a base URL with or without `/v1`. */
export function endpointUrl(baseUrl: string): string {
  return `${apiBase(baseUrl)}/v1/systemone`;
}

/** The model-list endpoint (`GET /v1/models`). */
export function modelsUrl(baseUrl: string): string {
  return `${apiBase(baseUrl)}/v1/models`;
}

/**
 * The model name the endpoint expects. TypeSafe's own API names models
 * `jev-1.14.0` / `jev-latest`; gateways (OpenRouter, Zuplo, LiteLLM) prefix
 * the vendor (`jev/jev-1.14.0`). Against api.typesafe.ai the prefix is
 * stripped — the direct API answers it with HTTP 400.
 */
export function effectiveModel(baseUrl: string, model: string): string {
  const trimmed = model.trim();
  let host = '';
  try {
    host = new URL(apiBase(baseUrl)).hostname;
  } catch {
    return trimmed;
  }
  return host === 'api.typesafe.ai' ? trimmed.replace(/^(jev|typesafe(-ai)?)\//, '') : trimmed;
}

/**
 * A short, content-free reason of a 4xx body for the logs: the API's
 * `error_type` and, for validation errors, the offending field paths — never
 * a message text (it may quote the request).
 */
export function errorReason(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const detail = (body as Record<string, unknown>)['detail'];
  if (Array.isArray(detail)) {
    const locs = detail
      .map((d) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>)['loc'] : undefined))
      .filter(Array.isArray)
      .map((loc) => (loc as unknown[]).filter((p) => typeof p === 'string' || typeof p === 'number').join('.'))
      .slice(0, 3);
    return locs.length > 0 ? `invalid ${locs.join(', ')}` : undefined;
  }
  if (typeof detail === 'object' && detail !== null) {
    const type = (detail as Record<string, unknown>)['error_type'] ?? (detail as Record<string, unknown>)['type'];
    return typeof type === 'string' ? type.slice(0, 60) : undefined;
  }
  return undefined;
}

/** The model names the account may use (`GET /v1/models`). */
/** The model to use when `wanted` is not available to the key: the moving
 *  stable alias, else the first listed name; undefined when `wanted` is. */
export function fallbackModel(wanted: string, available: readonly string[]): string | undefined {
  if (available.length === 0 || available.includes(wanted)) return undefined;
  return available.includes('jev-latest') ? 'jev-latest' : available[0];
}

export async function listModels(opts: Pick<JevClientOptions, 'baseUrl' | 'apiKey' | 'timeoutMs' | 'fetch'>): Promise<string[]> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(modelsUrl(opts.baseUrl), {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(Math.max(opts.timeoutMs, 5000)),
  });
  if (!res.ok) throw new JevError(`HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
  return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
}

export interface JevBatchCallResult extends DecisionBatchResult {
  costUsd?: number;
}

export interface JevClient {
  choose(req: DecisionChoiceRequest): Promise<JevCallResult>;
  decideAll(req: DecisionBatchRequest): Promise<JevBatchCallResult>;
}

export function createJevClient(opts: JevClientOptions): JevClient {
  const doFetch = opts.fetch ?? fetch;
  const url = endpointUrl(opts.baseUrl);
  const modelOf = (): string => effectiveModel(opts.baseUrl, typeof opts.model === 'function' ? opts.model() : opts.model);

  /** POST one System One body; the parsed JSON plus the call's cost. */
  async function post(body: Record<string, unknown>, callerSignal?: AbortSignal): Promise<{ json: unknown; costUsd?: number }> {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new JevError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      let reason: string | undefined;
      try {
        reason = errorReason(await res.json());
      } catch {
        reason = undefined;
      }
      throw new JevError(
        `HTTP ${res.status}${reason !== undefined ? ` (${reason})` : ''}`,
        res.status,
        retryAfterMs(res.headers.get('retry-after')),
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new JevError('response is not JSON');
    }
    const costHeader = res.headers.get('x-cost-usd');
    const cost = Number(costHeader);
    return { json, ...(costHeader !== null && Number.isFinite(cost) ? { costUsd: cost } : {}) };
  }

  return {
    async decideAll(req) {
      const { json, costUsd } = await post(buildBatchBody(req, modelOf()), req.signal);
      return { ...parseBatchAnswers(req, json), ...(costUsd !== undefined ? { costUsd } : {}) };
    },
    async choose(req) {
      const { json, costUsd } = await post(buildRequestBody(req, modelOf()), req.signal);
      return { ...parseChoiceAnswer(req, json), ...(costUsd !== undefined ? { costUsd } : {}) };
    },
  };
}
