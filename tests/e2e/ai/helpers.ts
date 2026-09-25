import { expect, type Page } from "@playwright/test";
import { angleNear, type PoseSummary } from "../creature/lab-bridge";

export interface DecisionFlowState {
  status: string;
  provider: string;
  anticipationMs: number;
  anticipationAt: number;
  conflictedAt: number;
  resolvedAt: number;
  revision: number;
  contextSize: number;
  lastModel: string;
  lastSource: string;
  errorKind: string | null;
}

declare global {
  interface Window {
    __YURAGOO_DECISION_E2E__?: {
      submit(text: string, choiceId: string): Promise<void>;
      state(): DecisionFlowState;
      pose(): PoseSummary;
      setMockDelay(ms: number): void;
      setFailNext(kind: string): void;
      setMockScenarioKey(key?: string): void;
    };
  }
}

export const flowState = (page: Page): Promise<DecisionFlowState | null> =>
  page.evaluate(() => window.__YURAGOO_DECISION_E2E__?.state() ?? null);

export const submitPost = (page: Page, text: string, choiceId: string): Promise<void> =>
  page.evaluate(
    ({ text: t, choiceId: c }) =>
      window.__YURAGOO_DECISION_E2E__?.submit(t, c) ?? Promise.resolve(),
    { text, choiceId },
  );

export const decisionPose = (page: Page): Promise<PoseSummary | null> =>
  page.evaluate(() => window.__YURAGOO_DECISION_E2E__?.pose() ?? null);

export const setMockDelay = (page: Page, ms: number): Promise<void> =>
  page.evaluate((v) => window.__YURAGOO_DECISION_E2E__?.setMockDelay(v), ms);

export const setFailNext = (page: Page, kind: string): Promise<void> =>
  page.evaluate((v) => window.__YURAGOO_DECISION_E2E__?.setFailNext(v), kind);

export const setMockScenarioKey = (page: Page, key?: string): Promise<void> =>
  page.evaluate((k) => window.__YURAGOO_DECISION_E2E__?.setMockScenarioKey(k), key);

export const waitDecisionReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__YURAGOO_DECISION_E2E__ !== undefined);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
};

export const flowStatusIs = (page: Page, status: string, timeout = 5000) =>
  expect(page.getByTestId("flow-status")).toHaveAttribute("data-status", status, { timeout });

export const dominantNear = (page: Page, angle: number) =>
  expect
    .poll(async () => angleNear((await decisionPose(page))?.dominantAngleRad, angle), {
      timeout: 4000,
    })
    .toBe(true);

// Canonical slot angles for four choices: a top, b right, c bottom, d left.
export const SLOT_ANGLES_4 = [-Math.PI / 2, 0, Math.PI / 2, Math.PI] as const;

// Staging constants mirrored from apps/web/src/dev/decision-flow.ts — the app
// module graph is not importable from Playwright (pulls pixi.js), so these
// are asserted against bridge timestamps instead of imported.
export const MIN_ANTICIPATION_MS = 700;
export const CONFLICT_DWELL_MS = 1500;
