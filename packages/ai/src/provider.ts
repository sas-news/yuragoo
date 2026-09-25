import type { DecisionResult, DecisionState } from "@yuragoo/protocol";

export interface DecisionProvider {
  evaluate(state: DecisionState, signal?: AbortSignal): Promise<DecisionResult>;
}
