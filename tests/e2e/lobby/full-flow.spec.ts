// Task 28 gate: the whole product flow on real DOM controls — home create,
// invite joins, host edits, settings, ready, a TURN match, lobby return +
// restart, plus the failure matrix. sendRaw is ONLY for probes no UI emits.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { EVIDENCE_DIR } from "./full-flow-helpers";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actTurn,
  armContent,
  copyInvite,
  createViaHome,
  joinViaLink,
  newPage,
  pickAndSee,
  playMatch,
  readyStart,
  rejoinViaInvite,
  seat,
} from "./full-flow-helpers";
import { type GenerationFixture, startGenerationFixture } from "./gen-fixture";
import {
  API,
  createRoom,
  revision,
  sendRawError,
  waitChoiceLabelOn,
  waitMemberCount,
  waitReadyCount,
  waitScenarioOn,
} from "./helpers";
import { type JevFixture, startJevFixture } from "../rooms/mp-fixture";

const API_Q = `api=${encodeURIComponent(API)}&hb=250`;
const contexts: BrowserContext[] = [];
const failureLog: string[] = [];
let gen: GenerationFixture, jev: JevFixture;
test.beforeAll(async () => {
  gen = await startGenerationFixture();
  jev = await startJevFixture();
});
// gen.mode reset + context sweep between tests — fixtures survive the file.
test.afterEach(async () => {
  gen.mode = "ok";
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "task-28-failure.log"), `${failureLog.join("\n")}\n`);
  await Promise.all([gen?.close(), jev?.close()]);
});

test("happy: home create -> invite -> 4-seat manual TURN match -> lobby -> restart", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const videoDir = mkdtempSync(join(tmpdir(), "yuragoo-t28-video-"));
  const host = await createViaHome(browser, contexts, API_Q, videoDir);
  const invite = await copyInvite(host);
  const members: Page[] = [];
  for (const [i, name] of ["メンバー1", "<b>script</b>", "れん"].entries()) {
    members.push(await joinViaLink(browser, contexts, invite, name));
    await waitMemberCount(host, i + 2);
  }
  const all = [host, ...members];
  // The HTML-ish display name renders as literal text — React escapes it.
  const chip = host.locator("[data-player-id]", { hasText: "<b>script</b>" });
  await expect(chip).toHaveCount(1);
  expect(await chip.locator("b").count()).toBe(0);
  // Fragment erased at join; the back/forward trip leaks no secret.
  const joiner = members[0] as Page;
  expect(await joiner.evaluate(() => window.location.hash)).toBe("");
  await joiner.goBack();
  await joiner.goForward();
  await rejoinViaInvite(joiner, invite, "メンバー1");
  await armContent(host, members[0] as Page, 4);
  await pickAndSee(host, members[0] as Page, "2"); // 2 rounds
  await pickAndSee(host, members[0] as Page, "30秒");
  await readyStart(all);
  await actTurn(all, "pass", ""); // turn 1 passes; the rest post via the dock
  expect(await playMatch(all)).toMatch(/勝ち|ひきわけ|むこう/);
  // One member's "back to lobby" returns EVERYONE — no instant restart.
  await (members[1] as Page).getByTestId("back-to-lobby").click();
  for (const p of all)
    await p.getByRole("button", { name: "準備OKにする" }).waitFor({ timeout: 30_000 });
  const feed = (all[0] as Page).locator("[data-testid='feed-line']");
  await readyStart(all);
  for (const p of all) await p.locator("[data-turn-player]").waitFor({ timeout: 30_000 });
  await expect(feed.filter({ hasText: "ゲーム開始" })).toHaveCount(2);
  const video = host.video();
  await host.context().close();
  if (video === null) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  copyFileSync(await video.path(), join(EVIDENCE_DIR, "task-28-happy.webm"));
});

test("happy: generated choices carry the same flow to a finish", async ({ browser }) => {
  test.setTimeout(180_000);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const members: Page[] = [];
  for (const name of ["あいこ", "れん", "むぎ"]) {
    members.push(await seat(browser, contexts, room.roomId, room.inviteSecret, name));
    await waitMemberCount(host, members.length + 1);
  }
  const all = [host, ...members];
  await host.locator("textarea").fill("夜のおやつ会議");
  // The debounced commit landed once the member's read view shows it.
  await waitScenarioOn(members[0] as Page, "夜のおやつ会議");
  await host.getByRole("button", { name: /AIで選択肢を生成/ }).click();
  await expect(host.locator("[data-proposal-label]")).toHaveCount(4, { timeout: 20_000 });
  await host.getByRole("button", { name: "生成案を適用" }).click();
  await waitChoiceLabelOn(members[0] as Page, "c3", "生成案4");
  await pickAndSee(host, members[0] as Page, "1"); // 1 round
  await readyStart(all);
  expect(await playMatch(all)).toMatch(/勝ち|ひきわけ|むこう/);
});

test("failure: host transfers mid-generation — lobby stays consistent", async ({ browser }) => {
  test.setTimeout(120_000);
  gen.mode = "hold";
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const m1 = await seat(browser, contexts, room.roomId, room.inviteSecret, "つぎ");
  const m2 = await seat(browser, contexts, room.roomId, room.inviteSecret, "みなみ");
  await waitMemberCount(host, 3);
  await host.locator("textarea").fill("とちゅうで転送されるシナリオ");
  await waitScenarioOn(m1, "とちゅうで転送されるシナリオ"); // debounced commit landed
  const genBaseline = gen.requests.length;
  await host.getByRole("button", { name: /AIで選択肢を生成/ }).click();
  const pollGen = expect.poll(() => gen.requests.length, { timeout: 20_000 });
  await pollGen.toBeGreaterThanOrEqual(genBaseline + 1); // cumulative across tests
  await host.context().close(); // the host's page dies mid-generation
  await m1.getByRole("button", { name: "はじめる" }).waitFor({ timeout: 20_000 });
  gen.releaseHeld();
  await expect(m1.locator("[data-proposal-label]")).toHaveCount(3, { timeout: 20_000 });
  failureLog.push(`mid-gen host transfer -> revision m1=${await revision(m1)}`);
  await m1.getByRole("button", { name: "生成案を適用" }).click();
  // Host's vacated draft slid to the orphan tail; apply fills by position.
  await waitChoiceLabelOn(m2, "c2", "生成案2");
  await waitChoiceLabelOn(m2, "c0", "生成案3");
  await expect(m1.locator("textarea")).toHaveValue("とちゅうで転送されるシナリオ");
});

test("failure: join/leave mid-edit keeps the host's inputs", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const m1 = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー1");
  await waitMemberCount(host, 2);
  await host.locator("textarea").fill("書きかけのシナリオ");
  const m2 = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー2");
  await waitMemberCount(host, 3);
  await expect(host.locator("textarea")).toHaveValue("書きかけのシナリオ");
  await host.locator('[data-choice-id="c0"] input').fill("途中の選択肢");
  await m2.getByRole("button", { name: "へやを出る" }).click();
  await m2.getByTestId("leave-confirm-yes").click();
  await waitMemberCount(host, 2);
  await expect(host.locator('[data-choice-id="c0"] input')).toHaveValue("途中の選択肢");
  await waitScenarioOn(m1, "書きかけのシナリオ"); // survivor converges on the ledger
  failureLog.push(`mid-edit join+leave -> revision=${await revision(host)}`);
});

test("failure: an invalid invite refuses with a friendly error", async ({ browser }) => {
  test.setTimeout(60_000);
  const room = await createRoom();
  // Bad secret + dead-room link both land on the friendly error line.
  const paths = [`/r/${room.roomId}?${API_Q}#not-the-secret`, `/r/${"0".repeat(64)}?${API_Q}#x`];
  for (const path of paths) {
    const page = await newPage(browser, contexts);
    await page.goto(path);
    await page.getByLabel(/おなまえ/).fill("ならずもの");
    await page.getByRole("button", { name: "へやにはいる" }).click();
    await expect(page.getByText(/へやに入れませんでした/)).toBeVisible({ timeout: 20_000 });
    failureLog.push(`bad invite ${path.slice(0, 20)} -> friendly error`);
  }
});

test("failure: stale revision + settings change -> re-ready, safe start", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  await armContent(host, member, 2);
  const stale = await sendRawError(host, "updateLobbyContent", {
    scenario: "古い上書き",
    expectedLobbyRevision: 0,
  });
  failureLog.push(`stale revision -> ${stale}`);
  expect(stale).toContain("lobby-revision-conflict");
  await expect(host.locator("textarea")).toHaveValue("夜のおやつ会議");
  const pages = [host, member];
  for (const p of pages) await p.getByRole("button", { name: "準備OKにする" }).click();
  for (const p of pages) await waitReadyCount(p, 2);
  const panel = '[data-settings="panel"]';
  await host.locator(panel).getByRole("button", { name: "早期決着：オフ", exact: true }).click();
  await expect(
    member.locator(panel).getByRole("button", { name: "早期決着：オン", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  for (const p of pages) await waitReadyCount(p, 2); // knobs never un-ready
  await host.locator(panel).getByRole("button", { name: "いっせいに", exact: true }).click();
  for (const p of pages) await waitReadyCount(p, 0);
  await expect(host.getByRole("button", { name: "はじめる" })).toBeDisabled();
  await readyStart(pages);
});

test("failure: AI unavailable — manual editing still completes a match", async ({ browser }) => {
  test.setTimeout(120_000);
  gen.mode = "garbage";
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  await host.locator("textarea").fill("AIがこないシナリオ");
  await waitScenarioOn(member, "AIがこないシナリオ"); // debounced commit landed
  await host.getByRole("button", { name: /AIで選択肢を生成/ }).click();
  await expect(host.locator('[role="alert"]')).toContainText("生成に失敗", { timeout: 20_000 });
  failureLog.push("generation unavailable -> manual path");
  await armContent(host, member, 2); // everything by hand still lands
  await pickAndSee(host, member, "1");
  await readyStart([host, member]);
  expect(await playMatch([host, member])).toMatch(/勝ち|ひきわけ|むこう/);
});

test("server-authoritative: member commands cannot bypass the lobby gates", async ({ browser }) => {
  test.setTimeout(90_000);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  await host.locator("textarea").fill("ホストのシナリオ");
  const rev = await revision(host);
  const probes = [
    ["updateLobbyContent", { scenario: "乗っ取り", expectedLobbyRevision: rev }],
    ["startGame", {}],
    ["updateLobby", { mode: "live" }],
    ["generateChoices", {}],
    ["closeRoom", {}],
  ] as const;
  for (const [type, payload] of probes) {
    const msg = await sendRawError(member, type, payload);
    failureLog.push(`member ${type} -> ${msg}`);
    expect(msg).toContain("not-host");
  }
  expect(await revision(member)).toBe(rev);
  await expect(member.locator('[aria-label="シナリオ"]')).toContainText("ホストのシナリオ");
});
