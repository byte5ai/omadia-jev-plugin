import { DECISION_MODEL_SERVICE_NAME, type JevPluginContext } from './contract.js';
import { createJevClient, effectiveModel, fallbackModel, listModels } from './jevClient.js';
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
export const DEFAULT_MODEL = 'jev-1.14.0';
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
  const baseUrl = text(ctx.config.get<unknown>('jev_base_url'), DEFAULT_BASE_URL);
  const configured = effectiveModel(baseUrl, text(ctx.config.get<unknown>('jev_model'), DEFAULT_MODEL));
  let model = configured;
  const timeoutMs = positiveInt(ctx.config.get<unknown>('jev_timeout_ms'), DEFAULT_TIMEOUT_MS);
  const tasks = text(ctx.config.get<unknown>('jev_tasks'), 'all');
  const service = createJevDecisionService({
    client: createJevClient({ baseUrl, apiKey, model: () => model, timeoutMs }),
    tasks,
    log: (m) => ctx.log(m),
  });
  const dispose = ctx.services.provide(DECISION_MODEL_SERVICE_NAME, service);
  ctx.log(`[decision-jev] ${PROVIDER_ID} published: model=${model} base=${baseUrl} timeout=${timeoutMs}ms tasks=${tasks}`);
  // one content-free check at activation: is the model available to this
  // key? A wrong name otherwise fails every turn with HTTP 400 — so switch
  // to the stable alias (accounts may only see aliases) and say so.
  void listModels({ baseUrl, apiKey, timeoutMs })
    .then((names) => {
      const fallback = fallbackModel(configured, names);
      if (fallback === undefined) {
        ctx.log(`[decision-jev] model ${configured} available`);
        return;
      }
      model = fallback;
      ctx.log(
        `[decision-jev] WARNING model ${configured} is not available to this key (available: ${names.join(', ')}) — using ${fallback}`,
      );
    })
    .catch((err: unknown) => {
      ctx.log(`[decision-jev] model check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  return {
    close(): Promise<void> {
      dispose();
      return Promise.resolve();
    },
  };
}
