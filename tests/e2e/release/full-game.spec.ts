// Task 39 release gate — the complete product path on real pages: home
// create -> invite link -> lobby edit -> live match -> kamishibai ending
// -> close + full deletion. Everything rides the page's own DOM controls
// (sendRaw only where no UI exists, like requestDecision). The offline
// mid-match failure leg lives in mid-game-reconnect.spec.ts.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { armAndStart, collectPanels, finishMatch, postWithTilts } from "../story/ending-helpers";
import { copyInvite, createViaHome, joinViaLink } from "../lobby/full-flow-helpers";
import { API, waitMemberCount } from "../lobby/helpers";
import { type JevFixture, startJevFixture } from "../rooms/mp-fixture";

const API_Q = `api=${encodeURIComponent(API)}&hb=250`;
const contexts: BrowserContext[] = [];
let jev: JevFixture;
test.beforeAll(async () => {
  jev = await startJevFixture();
});
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  await jev?.close();
});

const live = { mode: "live", seed: 21, liveSeconds: 120, hostDecision: true };

test("happy: create -> invite -> 4-seat match -> identical kamishibai -> close wipes", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const host = await createViaHome(browser, contexts, API_Q);
  const invite = await copyInvite(host);
  const members: Page[] = [];
  for (const [i, name] of ["ふたりめ", "さんにんめ", "よにんめ"].entries()) {
    members.push(await joinViaLink(browser, contexts, invite, name));
    await waitMemberCount(host, i + 2);
  }
  const pages = [host, ...members];

  // Choice rows grow with membership — a 4-seat lobby arms 4 labels.
  await armAndStart(host, pages, {
    scenario: "よるのおやつ会議",
    choices: ["クッキー", "ドーナツ", "プリン", "ゼリー"],
    settings: live,
  });
  await postWithTilts(pages, [
    "まっくらやみをてらして",
    "あまいにおいがした",
    "みんなでわらった",
    "そっとよるをあるいた",
  ]);
  await finishMatch(pages, host);

  // All four readers hold the identical panel set, each paging alone.
  const sets = await Promise.all(pages.map(collectPanels));
  for (const s of sets) expect(s).toEqual(sets[0]);
  expect(sets[0]?.length ?? 0).toBeGreaterThanOrEqual(3);

  // Host-only close: confirm -> every page leaves the room for good.
  for (const m of members) await expect(m.getByTestId("close-room")).toHaveCount(0);
  await host.getByTestId("close-room").click();
  await host.getByTestId("close-room-confirm").click();
  for (const p of pages) {
    await expect(p.getByTestId("kamishibai-panel")).toHaveCount(0);
  }
  // The dead URL serves no join — a fresh context with the same invite
  // must land on the error path, never on a live lobby.
  const late = await browser.newContext();
  contexts.push(late);
  const latePage = await late.newPage();
  await latePage.goto(invite);
  await latePage.getByLabel(/おなまえ/).fill("おくれてきた");
  await latePage.getByRole("button", { name: "へやにはいる" }).click();
  await latePage.waitForTimeout(8_000);
  expect(await latePage.locator("[data-player-id]").count()).toBe(0);
});
