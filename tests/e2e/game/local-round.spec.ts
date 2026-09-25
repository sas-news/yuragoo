// Task 15: the local single-screen match at /play. Real UI drives the whole
// loop — input -> AI eval -> core reduce -> creature pull -> result overlay
// -> rematch — against the real reduce() with a deterministic mock provider
// (favor-<poster slot> fixtures, so the winner is always the LAST poster).
// URL knobs keep it deterministic: players/mode/seed pick the setup,
// evalDelay stretches the provider mid-flight, failEval makes it throw,
// dwell=N widens the early-decision window so tests never race adhesion.
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

const gotoPlay = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/play?${query}`);
  await page.waitForFunction(() => window.__localBridge !== undefined);
  await expect(page.getByTestId("setup-panel")).toBeVisible();
};

const localState = (page: Page): Promise<GameState | null> =>
  page.evaluate(() => window.__localBridge?.state() ?? null);

const distsOf = (page: Page) => page.evaluate(() => window.__localBridge?.dists() ?? {});

const feedItems = (page: Page) => page.getByTestId("feed-item");

const startMatch = async (page: Page): Promise<void> => {
  await page.getByTestId("start-button").click();
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "playing");
};

const waitFinished = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "finished", undefined, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("result-overlay")).toBeVisible();
};

// One full turn through the real dock: fill -> send -> feed gains the post.
const postViaUi = async (page: Page, text: string): Promise<void> => {
  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled();
  const before = await feedItems(page).count();
  await page.getByTestId("game-input").fill(text);
  await send.click();
  await expect(feedItems(page)).toHaveCount(before + 1);
};

const argmax = (dist: readonly DecisionDistribution[]): number => {
  let best = 0;
  dist.forEach((d, i) => {
    if (d.probability > (dist[best]?.probability ?? -1)) best = i;
  });
  return best;
};

// Wait until the evaluation for post `p<n>` has landed in the bridge dists.
const waitDist = (page: Page, postId: string, timeout = 10_000) =>
  page.waitForFunction((id) => window.__localBridge?.dists()[id] !== undefined, postId, {
    timeout,
  });

test("happy: 4 players x 3 rounds -> winner overlay -> rematch", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=turn&seed=7&dwell=20");
  await startMatch(page);
  const stage = page.getByTestId("creature-stage");
  await expect(stage).toHaveAttribute("data-status", "ready");

  const posters: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const before = await localState(page);
    const seat = before?.turnOrder[before.turnIndex];
    if (seat === undefined) throw new Error("no acting seat");
    posters.push(seat);
    await postViaUi(page, `ひとこと${i}`);
    if (i === 0) {
      // The creature visibly "heard" the post (the ~950ms flicker).
      await expect(stage).toHaveAttribute("data-state", "hesitating");
    }
    // The creature pulls toward the poster's slot once the eval lands.
    const postId = `p${i + 1}`;
    await waitDist(page, postId);
    const state = await localState(page);
    const post = state?.posts[i];
    const dist = (await distsOf(page))[postId];
    const slot = state?.roster.find((p) => p.id === post?.playerId)?.slot;
    if (dist === undefined || slot === undefined) throw new Error("dist missing");
    expect(argmax(dist)).toBe(slot);
  }

  await waitFinished(page);
  const final = await localState(page);
  const outcome = final?.outcome;
  expect(outcome?.kind).toBe("winner");
  if (outcome?.kind === "winner") {
    // Deterministic mock: the last post's dist favors its poster's slot.
    expect(outcome.playerId).toBe(posters[posters.length - 1]);
  }
  const overlay = page.getByTestId("result-overlay");
  await expect(overlay).toContainText("食べ物がならんでいる");
  await expect(overlay.getByTestId("result-choice")).toHaveCount(4);
  await expect(page.getByTestId("result-outcome")).toContainText("の勝ち");

  // Rematch: fresh epoch, empty posts/feed/bubbles, stage remounts healthy.
  await page.getByTestId("rematch-button").click();
  await page.waitForFunction(
    () => window.__localBridge?.epoch() === 1 && window.__localBridge?.state()?.phase === "playing",
  );
  const fresh = await localState(page);
  expect(fresh?.posts).toHaveLength(0);
  expect(fresh?.seq).toBe(0);
  await expect(feedItems(page)).toHaveCount(0);
  await expect(page.locator("[data-testid^='bubble-']")).toHaveCount(0);
  expect(Object.keys(await distsOf(page))).toHaveLength(0);
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
});

test("failure: a rematch mid-eval drops the stale provider answer", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=turn&seed=7&evalDelay=2500&dwell=20");
  await startMatch(page);
  await postViaUi(page, "おそいこたえ"); // eval lands ~2.5s after accept
  await page.evaluate(() => window.__localBridge?.rematch());
  await page.waitForFunction(
    () => window.__localBridge?.epoch() === 1 && window.__localBridge?.state()?.phase === "playing",
  );
  // Past the stale eval's landing time: nothing from epoch 0 may arrive.
  await page.waitForTimeout(3200);
  const state = await localState(page);
  expect(state?.phase).toBe("playing");
  expect(state?.posts).toHaveLength(0);
  expect(state?.seq).toBe(0);
  expect(Object.keys(await distsOf(page))).toHaveLength(0);
  // …and the new epoch still evaluates normally.
  await postViaUi(page, "あたらしいこたえ");
  await waitDist(page, "p1", 8000);
  const after = await localState(page);
  expect(after?.posts).toHaveLength(1);
  expect(after?.posts[0]?.status).toBe("evaluated");
});

test("failure: failEval ends in noContest and rematch still works", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=turn&seed=7&failEval=1&dwell=20");
  await startMatch(page);
  for (let i = 0; i < 12; i += 1) await postViaUi(page, `だめ${i}`);
  await waitFinished(page);
  const state = await localState(page);
  const outcome = state?.outcome;
  if (outcome?.kind !== "noContest") throw new Error(`expected noContest, got ${outcome?.kind}`);
  // Pending posts inside the cutoff force noContest/pending at settle.
  expect(outcome.reason).toBe("pending");
  await expect(page.getByTestId("result-outcome")).toContainText("こたえがまにあわなかった");
  await page.getByTestId("rematch-button").click();
  await page.waitForFunction(
    () => window.__localBridge?.epoch() === 1 && window.__localBridge?.state()?.phase === "playing",
  );
  expect((await localState(page))?.posts).toHaveLength(0);
});

test("happy: live mode lets a clicked seat post as that player", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=7&dwell=20");
  await startMatch(page);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
  const state = await localState(page);
  const other = state?.roster[1]?.id;
  if (other === undefined) throw new Error("no second seat");
  const seat = page.getByTestId(`seat-${other}`);
  await expect(seat).toBeVisible();
  await seat.click();
  await expect(seat).toHaveAttribute("data-current", "true");
  await postViaUi(page, "いっせいのこえ");
  const after = await localState(page);
  expect(after?.posts.at(-1)?.playerId).toBe(other);
});
