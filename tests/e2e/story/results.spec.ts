// Task 32 e2e: the kamishibai results reader over the real worker — one
// identical panel set per member, self-paced paging (no host-synced
// page), snapshot healing for a client that was offline at finish, host
// handover keeping the close-room gate, the confirm-close flow, and a
// rematch whose new game never quotes the old story.
//
// Generation is deliberately left UNPLUGGED (no 8792 fixture): every
// post-game call fails upstream and the template story stands, which is
// also the deterministic fallback contract under test.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createRoom, joinPage } from "../lobby/helpers";
import { type JevFixture, startJevFixture } from "../rooms/mp-fixture";
import {
  armAndStart,
  collectPanels,
  finishMatch,
  postWithTilts,
  storySize,
} from "./ending-helpers";

const contexts: BrowserContext[] = [];
let jev: JevFixture;
test.beforeAll(async () => {
  jev = await startJevFixture();
});
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  await jev.close();
});

// One fresh browser context + real /r/<id> page per seat — independent
// sockets, storage and credentialed sessions like separate browsers.
const seatPages = async (
  browser: Browser,
  roomId: string,
  secret: string,
  names: readonly string[],
): Promise<Page[]> => {
  const pages: Page[] = [];
  for (const name of names) {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const page = await ctx.newPage();
    await joinPage(page, roomId, secret, name);
    pages.push(page);
  }
  return pages;
};

const live = (seed: number) => ({
  mode: "live",
  seed,
  liveSeconds: 120,
  hostDecision: true,
});

test("happy: 4 members get the identical story, page at their own pace, rematch fresh", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const room = await createRoom();
  const pages = await seatPages(browser, room.roomId, room.inviteSecret, [
    "ホスト",
    "ふたりめ",
    "さんにんめ",
    "よにんめ",
  ]);
  const host = pages[0] as Page;
  const second = pages[1] as Page;
  await armAndStart(host, pages, {
    scenario: "よるのおやつ会議",
    choices: ["クッキー", "ドーナツ", "プリン", "ゼリー"],
    settings: live(7),
  });
  await postWithTilts(pages, [
    "まっくらやみをてらして",
    "あまいにおいがした",
    "みんなでわらった",
    "そっとよるをあるいた",
  ]);
  await finishMatch(pages, host);
  const n = await storySize(host);
  expect(n).toBeGreaterThanOrEqual(3);
  // Self-paced: the member walks ahead while the host is still on page 1.
  await second.getByTestId("panel-next").click();
  await expect(second.getByTestId("page-count")).toHaveText("2 / ".concat(String(n)));
  await expect(host.getByTestId("page-count")).toHaveText("1 / ".concat(String(n)));
  // Identical sets: kind/title/caption/quotes all match byte-for-byte.
  const sets = await Promise.all(pages.map(collectPanels));
  for (const s of sets) expect(s).toEqual(sets[0]);
  // Rematch: a member's backToLobby reopens the lobby for everyone; the
  // next game builds a brand-new story that never quotes the old one.
  await (pages[2] as Page).getByTestId("back-to-lobby").click();
  for (const p of pages) {
    await p.getByRole("button", { name: "準備OKにする" }).waitFor({ timeout: 20_000 });
  }
  await armAndStart(host, pages, {
    scenario: "あさのうんどうかい",
    choices: ["だいこん", "ラジオ", "リレー", "パン"],
    settings: live(9),
  });
  await postWithTilts(pages, ["あついひざしのしたで", "ゴールテープをきった"]);
  await finishMatch(pages, host);
  const fresh = JSON.stringify(await collectPanels(host));
  expect(await storySize(host)).toBeGreaterThanOrEqual(3);
  expect(fresh).toContain("あさのうんどうかい");
  expect(fresh).not.toContain("まっくらやみをてらして");
});

test("failure: offline-at-finish heals by snapshot; host handover; confirm-close", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const room = await createRoom();
  const pages = await seatPages(browser, room.roomId, room.inviteSecret, [
    "ホスト",
    "ふたりめ",
    "よみかけ",
  ]);
  const host = pages[0] as Page;
  const next = pages[1] as Page;
  const dropped = pages[2] as Page;
  await armAndStart(host, pages, {
    scenario: "うみのそこのパーティー",
    choices: ["かいがら", "ひかるいし", "もずく"],
    settings: live(11),
  });
  // The third member drops BEFORE finish: it never receives the
  // endingReady frames and must heal the whole story via snapshot.
  await dropped.context().setOffline(true);
  await postWithTilts([host, next], ["きみのこえがきこえる", "ふかいうみのそこで"]);
  await finishMatch([host, next], host);
  // Only the host owns the close button while the roster seat is theirs.
  await expect(next.getByTestId("close-room")).toHaveCount(0);
  const baseline = await collectPanels(host);
  await dropped.context().setOffline(false);
  await dropped.getByTestId("page-count").waitFor({ timeout: 60_000 });
  expect(await collectPanels(dropped)).toEqual(baseline);
  // Host handover: dropping the host's socket elects the next member,
  // who gains the close-room gate; the reconnected member does not.
  await host.context().close();
  await next.getByTestId("close-room").waitFor({ timeout: 30_000 });
  await expect(dropped.getByTestId("close-room")).toHaveCount(0);
  // Confirm-close: cancel keeps the room; confirm tears it down for all.
  await next.getByTestId("close-room").click();
  await next.getByTestId("close-room-cancel").click();
  await next.getByTestId("close-room").click();
  await next.getByTestId("close-room-confirm").click();
  for (const p of [next, dropped]) {
    await expect(p.locator("body")).toContainText("このへやは閉じられました", {
      timeout: 30_000,
    });
    await expect(p.getByTestId("kamishibai-panel")).toHaveCount(0);
  }
});
