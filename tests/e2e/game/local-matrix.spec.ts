// Task 16 Phase-3 gate: fixed-fixture matrix over the local match —
// {2,4,6 players} x {TURN, LIVE} x {default, optional accelerators} run for
// real on /play through the actual UI. Happy rows verify outcomes against an
// expected winner derived BEFORE the match ends (turn order / chosen seat);
// failure rows prove hazards never yield a wrong winner or a frozen screen.
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

// The host is always the pre-shuffle first roster id (LOCAL_PLAYER_IDS[0]).
const HOST_ID = "aiko";

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

const waitDist = (page: Page, postId: string) =>
  page.waitForFunction((id) => window.__localBridge?.dists()[id] !== undefined, postId, {
    timeout: 10_000,
  });

const waitFinished = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "finished", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("result-overlay")).toBeVisible();
};

// One full post through the real dock — fill -> send -> feed gains it.
const postViaUi = async (page: Page, text: string): Promise<void> => {
  const send = page.getByTestId("send-button");
  const feed = page.getByTestId("feed-item");
  await expect(send).toBeEnabled();
  const before = await feed.count();
  await page.getByTestId("game-input").fill(text);
  await send.click();
  await expect(feed).toHaveCount(before + 1);
};

// TURN: the dock posts as the current turn seat. Returns the id read BEFORE
// posting — the fixture's own record of who spoke.
const postAsTurnSeat = async (page: Page, text: string): Promise<string> => {
  const state = await localState(page);
  const seat = state?.turnOrder[state.turnIndex];
  if (seat === undefined) throw new Error("no acting seat");
  await postViaUi(page, text);
  return seat;
};

// LIVE: click the seat chip, then post through the dock as that player.
const postAsSeat = async (page: Page, seatId: string, text: string): Promise<void> => {
  const seat = page.getByTestId(`seat-${seatId}`);
  await seat.click();
  await expect(seat).toHaveAttribute("data-current", "true");
  await postViaUi(page, text);
};

const requestEndByHost = (page: Page): Promise<void> =>
  page.evaluate((host) => {
    const r = window.__localBridge?.dispatch({
      type: "request-end",
      playerId: host,
      nowMs: Date.now(),
    });
    if (r === undefined) throw new Error("no bridge");
  }, HOST_ID);

// The mock favors the poster's own slot (0.7 vs 0.1), so the newest landed
// dist's argmax is the LAST poster's slot — expected winner comes from who
// spoke last, independently of the reported outcome.
const expectEnd = async (page: Page, cause: string, winnerId: string): Promise<void> => {
  const state = await localState(page);
  expect(state?.endCause).toBe(cause);
  const outcome = state?.outcome;
  if (outcome?.kind !== "winner") {
    throw new Error(`expected winner ${winnerId}, got ${JSON.stringify(outcome)}`);
  }
  expect(outcome.playerId).toBe(winnerId);
  await expect(page.getByTestId("result-outcome")).toContainText("の勝ち");
};

const expectNoContest = async (page: Page): Promise<void> => {
  const outcome = (await localState(page))?.outcome;
  if (outcome?.kind !== "noContest") {
    throw new Error(`expected noContest, got ${JSON.stringify(outcome)}`);
  }
  expect(outcome.reason).toBe("pending");
  await expect(page.getByTestId("result-outcome")).toContainText("こたえがまにあわなかった");
};

const rosterOf = (page: Page) => page.evaluate(() => window.__localBridge?.state()?.roster ?? []);

// --- happy matrix: 6 combos, real matches, independently expected winners ---

test("matrix 2P TURN default: rounds run out, the last speaker wins", async ({ page }) => {
  await gotoPlay(page, "players=2&mode=turn&seed=7&dwell=30&grace=9");
  await startMatch(page);
  const posters: string[] = [];
  for (let i = 0; i < 6; i += 1) posters.push(await postAsTurnSeat(page, `まわし${i}`));
  await waitDist(page, "p6");
  await waitFinished(page);
  await expectEnd(page, "rounds", posters[5] ?? "");
});

test("matrix 4P TURN optional: host request-end settles on the last speaker", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=turn&seed=11&dwell=30&grace=9");
  await startMatch(page);
  const posters: string[] = [];
  for (let i = 0; i < 5; i += 1) posters.push(await postAsTurnSeat(page, `とちゅう${i}`));
  await waitDist(page, "p5"); // eval inside the cutoff before the host calls it
  await requestEndByHost(page);
  await waitFinished(page);
  await expectEnd(page, "host", posters[4] ?? "");
});

test("matrix 6P TURN default: rounds run out, the last speaker wins", async ({ page }) => {
  await gotoPlay(page, "players=6&mode=turn&seed=3&dwell=30&grace=9");
  await startMatch(page);
  const posters: string[] = [];
  for (let i = 0; i < 18; i += 1) posters.push(await postAsTurnSeat(page, `えんや${i}`));
  await waitDist(page, "p18");
  await waitFinished(page);
  await expectEnd(page, "rounds", posters[17] ?? "");
});

test("matrix 2P LIVE optional: dominance streak ends it early", async ({ page }) => {
  await gotoPlay(page, "players=2&mode=live&seed=5&dwell=1&grace=2");
  await startMatch(page);
  const roster = await rosterOf(page);
  const seat = roster[1]?.id;
  if (seat === undefined) throw new Error("no second seat");
  await postAsSeat(page, seat, "いっぱつめ");
  await waitDist(page, "p1");
  await postAsSeat(page, seat, "にぱつめ");
  await waitDist(page, "p2");
  await waitFinished(page);
  await expectEnd(page, "dwell", seat);
});

test("matrix 4P LIVE default: the match deadline settles on the last speaker", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=9&live=6&dwell=30&grace=9");
  await startMatch(page);
  const roster = await rosterOf(page);
  for (const [i, player] of roster.slice(0, 3).entries()) {
    await postAsSeat(page, player.id, `いっせい${i}`);
  }
  await waitDist(page, "p3"); // the last post is evaluated inside the cutoff
  await waitFinished(page);
  await expectEnd(page, "deadline", roster[2]?.id ?? "");
});

test("matrix 6P LIVE optional: host request-end settles on the last speaker", async ({ page }) => {
  await gotoPlay(page, "players=6&mode=live&seed=13&dwell=30&grace=9");
  await startMatch(page);
  const roster = await rosterOf(page);
  for (const [i, player] of [roster[0], roster[3], roster[5]].entries()) {
    if (player === undefined) throw new Error("missing seat");
    await postAsSeat(page, player.id, `わいわい${i}`);
  }
  await waitDist(page, "p3");
  await requestEndByHost(page);
  await waitFinished(page);
  await expectEnd(page, "host", roster[5]?.id ?? "");
});

// --- failure matrix: hazards never yield a wrong winner or a dead screen ---

test("failure LIVE: provider fails -> pending forces noContest", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=7&failEval=1&live=6");
  await startMatch(page);
  const seat = (await rosterOf(page))[0]?.id;
  if (seat === undefined) throw new Error("no seat");
  await postAsSeat(page, seat, "とどかない");
  await waitFinished(page);
  await expectNoContest(page);
  // No freeze: rematch boots a fresh playing epoch.
  await page.getByTestId("rematch-button").click();
  await page.waitForFunction(
    () => window.__localBridge?.epoch() === 1 && window.__localBridge?.state()?.phase === "playing",
  );
});

test("failure TURN: provider fails -> pending forces noContest", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=turn&seed=7&failEval=1&rounds=1&dwell=30");
  await startMatch(page);
  for (let i = 0; i < 4; i += 1) await postAsTurnSeat(page, `だめ${i}`);
  await waitFinished(page);
  await expectNoContest(page);
});

test("failure TURN: over-limit text is rejected and play continues", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=turn&seed=7&dwell=30&grace=9");
  await startMatch(page);
  const tooLong = "あ".repeat(141); // POST_TEXT_MAX_GRAPHEMES is 140
  await page.getByTestId("game-input").fill(tooLong);
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("input-error")).toContainText("文字数オーバー");
  expect((await localState(page))?.posts).toHaveLength(0);
  // The dock still works: a normal post lands right after.
  await postViaUi(page, "ふつうのこえ");
  expect((await localState(page))?.posts).toHaveLength(1);
});

test("failure LIVE optional: alternating dominance never streaks", async ({ page }) => {
  await gotoPlay(page, "players=4&mode=live&seed=7&dwell=1&grace=2");
  await startMatch(page);
  const roster = await rosterOf(page);
  const seatA = roster[0]?.id;
  const seatB = roster[1]?.id;
  if (seatA === undefined || seatB === undefined) throw new Error("missing seats");
  // A, B, A, B — every eval is dominant but on alternating slots, so the
  // streak resets to 1 each time and grace=2 must never fire.
  for (const [i, seat] of [seatA, seatB, seatA, seatB].entries()) {
    await postAsSeat(page, seat, `こうご${i}`);
    await waitDist(page, `p${i + 1}`);
  }
  await page.waitForTimeout(1200); // past the adhesion hold — still playing
  expect((await localState(page))?.phase).toBe("playing");
  // The host calls it: the winner is the LAST speaker (seatB), never an
  // earlier dominant one.
  await requestEndByHost(page);
  await waitFinished(page);
  await expectEnd(page, "host", seatB);
});
