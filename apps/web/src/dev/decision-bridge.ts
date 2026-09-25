// E2E bridge for the DecisionLab page: a window-global handle the Playwright
// helpers drive. Only reachable on the dev/e2e-gated /dev/decision page, so
// it is tree-shaken out of production builds together with the page itself.
import type { RefObject } from "react";
import type { PoseRenderSummary } from "@yuragoo/creature";
import type { FlowSnap } from "./decision-flow";
import type { LabSource } from "./decision-providers";

export interface DecisionE2eState extends FlowSnap {
  provider: LabSource;
}

export interface DecisionBridge {
  submit(text: string, choiceId: string): Promise<void>;
  state(): DecisionE2eState;
  pose(): PoseRenderSummary;
  setMockDelay(ms: number): void;
  setFailNext(kind: string): void;
  /** Pin the mock scenario key (e.g. "contest"); undefined restores favor-*. */
  setMockScenarioKey(key?: string): void;
}

export interface DecisionBridgeDeps
  extends Omit<DecisionBridge, "setMockDelay" | "setFailNext" | "setMockScenarioKey"> {
  readonly controls: {
    readonly mockDelay: RefObject<number>;
    readonly failNext: RefObject<string | null>;
    readonly scenarioKey: RefObject<string | undefined>;
  };
}

declare global {
  interface Window {
    __YURAGOO_DECISION_E2E__?: DecisionBridge;
  }
}

export const installDecisionBridge = (deps: DecisionBridgeDeps): (() => void) => {
  window.__YURAGOO_DECISION_E2E__ = {
    submit: deps.submit,
    state: deps.state,
    pose: deps.pose,
    setMockDelay: (ms) => {
      deps.controls.mockDelay.current = Math.max(0, ms);
    },
    setFailNext: (kind) => {
      deps.controls.failNext.current = kind;
    },
    setMockScenarioKey: (key) => {
      deps.controls.scenarioKey.current = key;
    },
  };
  return () => {
    delete window.__YURAGOO_DECISION_E2E__;
  };
};
