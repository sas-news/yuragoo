// Task 15b follow-ups for /play: the playing screen shows the scenario and
// every seat's assigned goal, and the early decision is a consecutive-
// dominance STREAK — `grace` straight dominant evals (default 3 = dominance
// + 2 grace posts) end the match, so a clear runaway still gets its 猶予.
// Same deterministic favor-<poster slot> mock and live-mode UI drive as
// local-round.spec.ts; dwell=N still widens the reducer's adhesionSeconds.
import { expect, type Page, test } from "@playwright/test";
import type { GameState } from "@yuragoo/game-core";
import type { DecisionDistribution } from "@yuragoo/protocol";

declare global {
  interface Window {
    __localBridge?: {
      state(): GameState | null;
      dispatch(action: unknown): { phase: string; seq: number };
      epoch(): number;
      readonly events: readonly { type: string }[];
      layout(): { stageWidth: number; stageHeight: number } | null;
      dists(): Record<string, readonly DecisionDistribution[]>;
      rematch(): void;
    };
  }
}

// Choice labels in slot order — a mirror of LOCAL_CHOICES in local/scenario.
const GOAL_LABELS = [
  "季節限定の濃厚プリン",
  "素朴な塩むすび",
  "なぞの紫色のゼリー",
  "何も食べずに我慢する",
  "あつあつのたいやき",
  "ひんやりクリームソーダ",
] as const;

const gotoPlay = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/play?${query}`);
  await page.waitForFunction(() => window.__localBridge !== undefined);
  await expect(page.getByTestId("setup-panel")).toBeVisible();
};

const localState = (page: Page): Promise<GameState | null> =>
  page.evaluate(() => window.__localBridge?.state() ?? null);

const startMatch = async (page: Page): Promise<void> => {
  await page.getByTestId("start-button").click();
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "playing");
};

const postViaUi = async (page: Page, text: string): Promise<void> => {
  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled();
  const before = await page.getByTestId("feed-item").count();
  await page.getByTestId("game-input").fill(text);
  await send.click();
  await expect(page.getByTestId("feed-item")).toHaveCount(before + 1);
};

// Wait until the evaluation for post `p<n>` has landed in the bridge dists.
const waitDist = (page: Page, postId: string) =>
  page.waitForFunction((id) => window.__localBridge?.dists()[id] !== undefined, postId, {
    timeout: 10_000,
  });

const waitFinished = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "finished", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("result-overlay")).toBeVisible();
};

test("scenario strip + seat goal labels + dock goal ride the match", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=7&dwell=30");
  await startMatch(page);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
  await page.waitForFunction(() => window.__localBridge?.layout() !== null);

  const strip = page.getByTestId("scenario-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("食べ物がならんでいる");
  await expect(strip).toContainText("甘党");

  const roster = (await localState(page))?.roster ?? [];
  expect(roster).toHaveLength(4);
  // Every seat chip carries its assigned goal under the player name.
  for (const player of roster) {
    await expect(page.getByTestId(`seat-goal-${player.id}`)).toContainText(
      GOAL_LABELS[player.slot] ?? "?",
    );
  }
  // The dock echoes the acting seat's goal — live's default seat is
  // roster[0]; clicking another seat retargets both the seat and the goal.
  const acting = roster[0];
  const other = roster[1];
  if (acting === undefined || other === undefined) throw new Error("missing seats");
  await expect(page.getByTestId("dock-goal")).toContainText(GOAL_LABELS[acting.slot] ?? "?");
  await page.getByTestId(`seat-${other.id}`).click();
  await expect(page.getByTestId("dock-goal")).toContainText(GOAL_LABELS[other.slot] ?? "?");
});

test("grace=2: the second straight dominant eval ends the match early", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=7&dwell=1&grace=2");
  await startMatch(page);
  await postViaUi(page, "プリンいっぱつ");
  await waitDist(page, "p1");
  expect((await localState(page))?.phase).toBe("playing"); // streak 1 < 2
  await postViaUi(page, "プリンにはつ");
  await waitDist(page, "p2");
  // streak 2 = grace -> dwell-complete -> settle -> finished (~dwell secs).
  await waitFinished(page);
  expect((await localState(page))?.endCause).toBe("dwell");
});

test("default grace (3): two dominant posts keep playing, the third ends it", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=7&dwell=1");
  await startMatch(page);
  await postViaUi(page, "ひとつめ");
  await waitDist(page, "p1");
  await postViaUi(page, "ふたつめ");
  await waitDist(page, "p2");
  // 猶予: streak 2 < grace 3 — even past the adhesionSeconds boundary the
  // match must still be playing; nothing may fire early.
  await page.waitForTimeout(1500);
  expect((await localState(page))?.phase).toBe("playing");
  await postViaUi(page, "みっつめ");
  await waitDist(page, "p3");
  await waitFinished(page);
  expect((await localState(page))?.endCause).toBe("dwell");
});
