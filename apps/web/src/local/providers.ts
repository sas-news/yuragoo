// Local-match evaluation providers (Task 15). Default is a seeded mock whose
// "favor-<choiceId>" fixtures always pull toward the POSTER's slot choice —
// deterministic outcomes for e2e. ?eval=live reuses the lab's loopback dev
// gateway client as-is; ?evalDelay=<ms> wraps any provider in a sleep (so a
// test can reset mid-eval); ?failEval=1 makes every call throw (the pending
// post then forces noContest at settle — 障害時は凍らせずnoContest).
import { type MockDecisionFixture, MockDecisionProvider } from "@yuragoo/ai";
import type { DecisionResult, DecisionState } from "@yuragoo/protocol";
import { delay } from "../dev/decision-flow";
import { createLiveEvaluate, LabEvaluationError } from "../dev/decision-providers";
import type { LocalChoice } from "./scenario";
import type { LocalParams } from "./session";

export interface LocalEvaluation {
  readonly result: DecisionResult;
  readonly source: "mock" | "live";
}
export type LocalEvaluate = (state: DecisionState) => Promise<LocalEvaluation>;

// Same loopback base the decision lab uses; no secrets, dev gateway only.
export const LOCAL_GATEWAY_URL = "http://127.0.0.1:8787";

export const buildMockEvaluate = (choices: readonly LocalChoice[]): LocalEvaluate => {
  const fixtures: MockDecisionFixture[] = [
    // favor-<id>: the poster's own choice dominates (0.7 vs 0.1 each other).
    ...choices.map((choice) => ({
      key: `favor-${choice.id}`,
      weights: Object.fromEntries(
        choices.map((c) => [c.id, c.id === choice.id ? 0.7 : 0.1] as const),
      ),
    })),
    // contest: a knife-edge race between the first two choices.
    {
      key: "contest",
      weights: Object.fromEntries(
        choices.map((c, i) => [c.id, i < 2 ? 0.45 : 0.1 / Math.max(1, choices.length - 2)]),
      ),
    },
  ];
  const provider = new MockDecisionProvider({ seed: 42, fixtures });
  return async (state) => ({ result: await provider.evaluate(state), source: "mock" });
};

const failingEvaluate: LocalEvaluate = async () => {
  throw new LabEvaluationError("forced", "評価は失敗する設定です (?failEval=1)");
};

export const selectEvaluate = (
  params: LocalParams,
  choices: readonly LocalChoice[],
  sessionId: string,
): LocalEvaluate => {
  const base: LocalEvaluate =
    params.evalKind === "live"
      ? createLiveEvaluate(LOCAL_GATEWAY_URL, sessionId)
      : buildMockEvaluate(choices);
  const provider = params.failEval ? failingEvaluate : base;
  if (params.evalDelayMs <= 0) return provider;
  const delayMs = params.evalDelayMs;
  return async (state) => {
    await delay(delayMs);
    return provider(state);
  };
};
