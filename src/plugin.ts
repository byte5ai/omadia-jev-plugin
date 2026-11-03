import { DECISION_MODEL_SERVICE_NAME, type JevPluginContext } from './contract.js';
import { createJevClient } from './jevClient.js';
import { createJevDecisionService, PROVIDER_ID } from './service.js';

/**
 * @omadia/decision-jev — TypeSafe Jev as the `decisionModel@1` provider.
 *
 * The fast path (`@omadia/fast-path` >= 0.2.0) asks it BEFORE any triage
 * model call whether a turn needs a language model, which data source answers
 * it, and whether a learned query fits as stored. Without an API key the
 * plugin activates but publishes nothing — the fast path keeps its LLM router.
 */

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev/jev-1.13.0';
/** below the fast path's 2 s decision deadline */
export const DEFAULT_TIMEOUT_MS = 1500;

export interface JevPluginHandle {
  close(): Promise<void>;
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function text(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
}

export async function activate(ctx: JevPluginContext): Promise<JevPluginHandle> {
  const apiKey = (await ctx.secrets.get('jev_api_key'))?.trim() ?? '';
  if (apiKey.length === 0) {
    ctx.log('[decision-jev] no jev_api_key in the vault — active, but no decision model published (fast path keeps its LLM router)');
    return { close: () => Promise.resolve() };
  }
  const model = text(ctx.config.get<unknown>('jev_model'), DEFAULT_MODEL);
  const baseUrl = text(ctx.config.get<unknown>('jev_base_url'), DEFAULT_BASE_URL);
  const timeoutMs = positiveInt(ctx.config.get<unknown>('jev_timeout_ms'), DEFAULT_TIMEOUT_MS);
  const tasks = text(ctx.config.get<unknown>('jev_tasks'), 'all');
  const service = createJevDecisionService({
    client: createJevClient({ baseUrl, apiKey, model, timeoutMs }),
    tasks,
    log: (m) => ctx.log(m),
  });
  const dispose = ctx.services.provide(DECISION_MODEL_SERVICE_NAME, service);
  ctx.log(`[decision-jev] ${PROVIDER_ID} published: model=${model} base=${baseUrl} timeout=${timeoutMs}ms tasks=${tasks}`);
  return {
    close(): Promise<void> {
      dispose();
      return Promise.resolve();
    },
  };
}
