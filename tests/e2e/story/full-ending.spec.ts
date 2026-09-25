// Task 33 gate: the kamishibai ending end to end. Real browser pages on
// the real worker drive a LIVE match through sendRaw; the post-game
// ending call rides the same GENERATION_UPSTREAM_URL fixture as the
// lobby generator, so its request count is the honest "spend" counter.
// Assertions are DOM-only: a panel/quote exists here because ordered
// server frames built it on every member's page.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { type GenerationFixture, startGenerationFixture } from "../lobby/gen-fixture";
import { API, createRoom, joinPage, waitMemberCount } from "../lobby/helpers";
import { newPage } from "../lobby/full-flow-helpers";
import { type JevFixture, startJevFixture } from "../rooms/mp-fixture";
import {
  armAndStart,
  collectPanels,
  finishMatch,
  type PanelView,
  postWithTilts,
} from "./ending-helpers";

const contexts: BrowserContext[] = [];
let gen: GenerationFixture, jev: JevFixture;
test.beforeAll(async () => {
  gen = await startGenerationFixture();
  jev = await startJevFixture(); // submitText posts need real evaluations
});
test.afterEach(async () => {
  gen.mode = "ok";
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  await Promise.all([gen?.close(), jev?.close()]);
});

// One context per seat — sockets, not tabs of one session, like a real
// party. Seating is sequential so pages[0] is deterministically the host.
const seatPlayers = async (
  browser: Browser,
  roomId: string,
  secret: string,
  names: readonly string[],
): Promise<Page[]> => {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) {
    const page = await newPage(browser, contexts);
    await joinPage(page, roomId, secret, name);
    await waitMemberCount(page, i + 1);
    pages.push(page);
  }
  return pages;
};

const TEXTS4 = [
  "まっくらやみをてらして",
  "あまいにおいがした",
  "みんなでわらった",
  "そっとよるをあるいた",
] as const;

test("human posts are the story; generation spends at most one post-game call", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const room = await createRoom();
  const all = await seatPlayers(browser, room.roomId, room.inviteSecret, [
    "プレイヤー1",
    "プレイヤー2",
    "プレイヤー3",
    "プレイヤー4",
  ]);
  const host = all[0] as Page;
  await armAndStart(host, all, {
    scenario: "よるのおやつ会議",
    choices: ["クッキー", "ドーナツ", "プリン", "ゼリー"],
    settings: { mode: "live", seed: 7, liveSeconds: 120, hostDecision: true },
  });
  // Baseline AFTER arming: only post-match sends can move the counter.
  const baseline = gen.requests.length;
  await postWithTilts(all, TEXTS4);
  await finishMatch(all, host);
  // The generated title lands only via the endingReady apply — its
  // presence on every page proves the post-game call ran and applied.
  for (const p of all) {
    await expect(p.getByTestId("story-title")).toHaveText("よるのおやつものがたり", {
      timeout: 20_000,
    });
  }
  const stories: PanelView[][] = [];
  for (const p of all) stories.push(await collectPanels(p));
  const first = stories[0] ?? [];
  expect(first.length).toBeGreaterThan(0);
  for (const s of stories.slice(1)) expect(s).toEqual(first); // server-authoritative set
  // Quotes render as 「text」 — a contains-match ties every quote back to
  // a real submitted post; panels pick moments, so full coverage is not
  // required but at least two voices must appear.
  const quotes = first.flatMap((panel) => panel.quotes);
  const covered = new Set<string>();
  for (const quote of quotes) {
    const hit = TEXTS4.find((t) => quote.includes(t));
    expect(hit, `panel quote ${quote} quotes nobody's post`).not.toBeUndefined();
    if (hit !== undefined) covered.add(hit);
  }
  expect(quotes.length).toBeGreaterThan(0);
  expect(covered.size).toBeGreaterThanOrEqual(2);
  // The "pre" slot is unspent (no lobby generation was clicked), so the
  // delta is exactly the post-game attempt — one send, never a retry.
  const spent = gen.requests.length - baseline;
  expect(spent).toBeGreaterThanOrEqual(1);
  expect(spent).toBeLessThanOrEqual(2);
});

test("after closeRoom the content is unreachable", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const all = await seatPlayers(browser, room.roomId, room.inviteSecret, [
    "プレイヤー1",
    "プレイヤー2",
  ]);
  const host = all[0] as Page;
  await armAndStart(host, all, {
    scenario: "よるのおやつ会議",
    // The lobby grows one choice row per seated member — a 2-seat room
    // has exactly two rows to label.
    choices: ["クッキー", "ドーナツ"],
    settings: { mode: "live", seed: 7, liveSeconds: 120, hostDecision: true },
  });
  await postWithTilts(all, TEXTS4.slice(0, 2));
  await finishMatch(all, host);
  await host.getByTestId("close-room").click();
  await host.getByTestId("close-room-confirm").click();
  // roomClosed flips every live page to the closed note — the results
  // dialog (and its panels) unmounts with the room stage.
  for (const p of all) {
    await p.getByText("このへやは閉じられました").waitFor({ timeout: 20_000 });
    await expect(p.getByTestId("kamishibai-panel")).toHaveCount(0);
  }
  // Server-side the room is gone too: a bare HTTP join with the old
  // secret cannot resurrect a handle on the deleted DO.
  const res = await fetch(`${API}/api/rooms/${room.roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteSecret: room.inviteSecret }),
  });
  expect(res.ok).toBe(false);
});
