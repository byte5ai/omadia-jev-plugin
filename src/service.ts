import type { DecisionBatchResult, DecisionChoiceResult, DecisionModelService } from './contract.js';
import { JevError, type JevClient } from './jevClient.js';

/**
 * The `decisionModel@1` service over a Jev client, with the guardrails a
 * per-turn caller needs:
 *
 *   - task filter (`jev_tasks`): a task Jev should not answer is refused at
 *     once, so the fast path takes its LLM path — the rollout lever;
 *   - circuit breaker: after {@link BREAKER_FAILURES} consecutive failures,
 *     or a 429 (for its `retry-after`), calls are refused for a cool-down
 *     instead of costing every turn a timeout;
 *   - one log line per call: task, choice, confidence, ms, cost — never the
 *     input or the option texts.
 */

export const PROVIDER_ID = 'jev';
export const BREAKER_FAILURES = 3;
export const BREAKER_COOLDOWN_MS = 30_000;
/** every fast-path task (`fast-path.gate`, `.source`, `.direct-plan`) */
export const ALL_TASKS = 'all';

export interface JevServiceDeps {
  client: Pick<JevClient, 'choose'> & Partial<Pick<JevClient, 'decideAll'>>;
  /** `jev_tasks` — `all` or a comma list of task ids */
  tasks: string;
  log: (message: string) => void;
  now?: () => number;
}

/** The task filter of `jev_tasks`; empty or `all` → every task. */
export function parseTasks(raw: string | undefined): (task: string) => boolean {
  const list = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (list.length === 0 || list.includes(ALL_TASKS)) return () => true;
  const set = new Set(list);
  return (task) => set.has(task);
}

export function createJevDecisionService(deps: JevServiceDeps): DecisionModelService {
  const now = deps.now ?? Date.now;
  const allowed = parseTasks(deps.tasks);
  let failures = 0;
  let openUntil = 0;

  function trip(ms: number, why: string): void {
    openUntil = now() + ms;
    failures = 0;
    deps.log(`[decision-jev] breaker open for ${Math.round(ms / 1000)} s (${why})`);
  }

  /** One guarded call: task filter, breaker, one log line, failure accounting. */
  async function guarded<T>(task: string, run: () => Promise<T>, describe: (r: T) => string): Promise<T> {
    if (!allowed(task)) throw new JevError(`task ${task} not enabled (jev_tasks)`);
    if (now() < openUntil) throw new JevError('circuit open');
    const t0 = now();
    try {
      const result = await run();
      failures = 0;
      deps.log(`[decision-jev] task=${task} ${describe(result)} ms=${now() - t0}`);
      return result;
    } catch (err) {
      const e = err instanceof JevError ? err : new JevError(err instanceof Error ? err.message : String(err));
      deps.log(`[decision-jev] task=${task} failed ms=${now() - t0}: ${e.message}`);
      if (e.status === 429) trip(e.retryAfterMs ?? BREAKER_COOLDOWN_MS, 'rate limited');
      else if (e.status === 401 || e.status === 403) trip(BREAKER_COOLDOWN_MS * 10, `HTTP ${e.status} — check jev_api_key`);
      else if (++failures >= BREAKER_FAILURES) trip(BREAKER_COOLDOWN_MS, `${BREAKER_FAILURES} failures in a row`);
      throw e;
    }
  }

  const tail = (model?: string, costUsd?: number): string =>
    (model !== undefined ? ` model=${model}` : '') + (costUsd !== undefined ? ` cost_usd=${costUsd}` : '');

  const client = deps.client;
  const decideAll = client.decideAll?.bind(client);
  return {
    provider: PROVIDER_ID,
    async choose(req): Promise<DecisionChoiceResult> {
      const result = await guarded(
        req.task,
        () => client.choose(req),
        (r) => `choice=${r.choice} conf=${r.confidence.toFixed(2)}` + tail(r.model, r.costUsd),
      );
      const { costUsd: _cost, ...decision } = result;
      return decision;
    },
    ...(decideAll
      ? {
          async decideAll(req): Promise<DecisionBatchResult> {
            const result = await guarded(
              req.task,
              () => decideAll(req),
              (r) => `questions=${Object.keys(req.questions).length} answers=${Object.keys(r.answers).length}` + tail(r.model, r.costUsd),
            );
            const { costUsd: _cost, ...batch } = result;
            return batch;
          },
        }
      : {}),
  };
}
