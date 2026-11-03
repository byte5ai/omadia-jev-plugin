import type { DecisionChoiceRequest, DecisionChoiceResult } from './contract.js';

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
  model: string;
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

/** The System One endpoint for a base URL with or without `/v1`. */
export function endpointUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/systemone`;
}

export function createJevClient(opts: JevClientOptions): { choose(req: DecisionChoiceRequest): Promise<JevCallResult> } {
  const doFetch = opts.fetch ?? fetch;
  const url = endpointUrl(opts.baseUrl);
  return {
    async choose(req) {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildRequestBody(req, opts.model)),
          signal,
        });
      } catch (err) {
        throw new JevError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        // never echo the body: it may quote the request
        throw new JevError(`HTTP ${res.status}`, res.status, retryAfterMs(res.headers.get('retry-after')));
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new JevError('response is not JSON');
      }
      const result = parseChoiceAnswer(req, body);
      const cost = Number(res.headers.get('x-cost-usd'));
      return { ...result, ...(Number.isFinite(cost) && res.headers.get('x-cost-usd') !== null ? { costUsd: cost } : {}) };
    },
  };
}
