/**
 * The `decisionModel@1` contract of `@omadia/plugin-api` (>= 1.53.0 for
 * `decideAll`; 1.52.0 hosts simply never call it),
 * mirrored structurally so the plugin needs no runtime import from the host.
 * Keep in sync with `middleware/packages/plugin-api/src/decisionModel.ts`.
 */

/** Service-registry key (bare, unversioned). */
export const DECISION_MODEL_SERVICE_NAME = 'decisionModel';

export interface DecisionOption {
  readonly id: string;
  readonly description: string;
}

export interface DecisionChoiceRequest {
  readonly task: string;
  readonly instruction: string;
  /** already privacy-masked by the caller */
  readonly input: string;
  readonly options: readonly DecisionOption[];
  readonly signal?: AbortSignal;
}

export interface DecisionChoiceResult {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly model?: string;
}

export type DecisionQuestion =
  | { readonly kind: 'choice'; readonly instruction: string; readonly options: readonly DecisionOption[] }
  | { readonly kind: 'yesno'; readonly instruction: string };

export interface DecisionBatchRequest {
  readonly task: string;
  /** already privacy-masked by the caller */
  readonly input: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly signal?: AbortSignal;
}

export type DecisionAnswer =
  | {
      readonly kind: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities?: Readonly<Record<string, number>>;
    }
  | { readonly kind: 'yesno'; readonly probability: number };

export interface DecisionBatchResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly model?: string;
}

export interface DecisionModelService {
  readonly provider: string;
  choose(req: DecisionChoiceRequest): Promise<DecisionChoiceResult>;
  /** plugin-api >= 1.53.0: several questions in one round trip */
  decideAll?(req: DecisionBatchRequest): Promise<DecisionBatchResult>;
}

/** The slice of `PluginContext` this plugin uses. */
export interface JevPluginContext {
  log(message: string): void;
  secrets: { get(key: string): Promise<string | undefined> };
  config: { get<T>(key: string): T | undefined };
  services: { provide<T>(name: string, impl: T): () => void };
}
