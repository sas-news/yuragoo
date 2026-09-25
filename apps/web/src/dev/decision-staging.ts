// Staged-reaction orchestration: anticipation dwell → optional 葛藤 dwell →
// commit. Pure async sequencing — React wiring lives in DecisionLab.tsx and
// the timing constants live in decision-flow.ts.
import type { AttractionSample, CreatureExpression } from "@yuragoo/creature";
import type { DecisionState } from "@yuragoo/protocol";
import {
  CONFLICT_DWELL_MS,
  CONFLICT_MARGIN,
  conflictSamples,
  delay,
  distributionSamples,
  type FlowSnap,
  formatResultLine,
  MIN_ANTICIPATION_MS,
  topTwoMargin,
} from "./decision-flow";
import { LabEvaluationError, type LabEvaluate } from "./decision-providers";

// Hooks the component supplies. isStale() is re-checked after every await so
// a newer submit cancels in-flight dwells with no late commit.
export interface StageHooks {
  show(samples: readonly AttractionSample[], expression: CreatureExpression): void;
  express(expression: CreatureExpression): void;
  patch(patch: Partial<FlowSnap>): void;
  result(line: string): void;
  isStale(): boolean;
  failNext(): string | null;
  mockDelayMs(): number;
}

const errorKind = (error: unknown): string =>
  error instanceof LabEvaluationError
    ? error.kind
    : error instanceof DOMException
      ? error.name
      : "internal";

export const runStagedEvaluation = async (
  hooks: StageHooks,
  evaluate: LabEvaluate,
  state: DecisionState,
  t0: number,
): Promise<void> => {
  try {
    const failKind = hooks.failNext();
    if (failKind !== null) {
      throw new LabEvaluationError(failKind, `forced failure: ${failKind}`);
    }
    const delayMs = hooks.mockDelayMs();
    if (delayMs > 0) await delay(delayMs);
    const outcome = await evaluate(state);
    if (hooks.isStale()) return; // stale submission: discard entirely
    // Hold the anticipation pose so the lean stays readable even when the
    // provider resolves instantly — the dwell is measured from submit.
    const dwell = MIN_ANTICIPATION_MS - (performance.now() - t0);
    if (dwell > 0) await delay(dwell);
    if (hooks.isStale()) return;
    // A knife-edge distribution earns a visible まよってる beat: the pose
    // splits across the two torn directions before the creature commits.
    if (topTwoMargin(outcome.result.distribution) < CONFLICT_MARGIN) {
      hooks.show(conflictSamples(outcome.result.distribution), "hesitating");
      hooks.patch({ status: "conflicted", conflictedAt: performance.now() - t0 });
      await delay(CONFLICT_DWELL_MS);
      if (hooks.isStale()) return;
    }
    const latencyMs = performance.now() - t0;
    hooks.show(distributionSamples(outcome.result.distribution), "engaged");
    hooks.result(formatResultLine(outcome, latencyMs));
    hooks.patch({
      status: "resolved",
      lastModel: outcome.result.model,
      lastSource: outcome.source,
      resolvedAt: latencyMs,
    });
  } catch (error) {
    if (hooks.isStale()) return;
    hooks.express("rest");
    hooks.patch({ status: "failed", errorKind: errorKind(error) });
  }
};
