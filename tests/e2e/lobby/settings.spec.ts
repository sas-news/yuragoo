// Task 26 gate: the shared mode/ending settings end to end on real /r/<id>
// pages against the real wrangler worker. The panel renders identically
// for every member, only the host's controls are live, a real change
// clears every ready flag, the start payload can only confirm the shared
// view, and the whole thing locks once the game exists.
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRoom,
  joinPage,
  sendRaw,
  sendRawError,
  waitMemberCount,
  waitReadyCount,
  waitScenarioOn,
} from "./helpers";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const EVIDENCE_DIR = join(process.cwd(), ".omo/evidence/yuragoo-development", `${stamp}-t26`);
const failureLog: string[] = [];
test.afterAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "task-26-failure.log"), `${failureLog.join("\n")}\n`);
});

const seat = async (
  browser: Browser,
  roomId: string,
  secret: string,
  name: string,
): Promise<Page> => {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  await joinPage(page, roomId, secret, name);
  return page;
};

const panel = (page: Page): Locator => page.locator('[data-settings="panel"]');
// A toggle row is the field div holding the switch's caption span.
const toggle = (p: Locator, caption: string): Locator =>
  p.locator("span", { hasText: caption }).locator("..").getByRole("button");
// exact: "3" is a substring of "30秒"; "20秒" is a substring of "120秒".
const pressed = (p: Locator, name: string): Locator =>
  p.getByRole("button", { name, exact: true, pressed: true });
const segment = (p: Locator, name: string): Locator => p.getByRole("button", { name, exact: true });

// Host fills the lobby content through the real fields so startGame's
// server gate is satisfied the ordinary way.
const armContent = async (host: Page, member: Page): Promise<void> => {
  await host.locator("textarea").fill("夜のおやつ会議");
  await waitScenarioOn(member, "夜のおやつ会議");
  for (const id of ["c0", "c1"]) {
    await host.locator(`[data-choice-id="${id}"] input`).fill(`おやつ${id}`);
  }
  await expect(member.locator(`[data-choice-id="c1"]`)).toContainText("おやつc1");
};

test("happy: shared view, host-only edits, ready reset and the start lock", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  const hp = panel(host);
  const mp = panel(member);

  // Every member sees the same contract defaults: TURN 20s x 3 rounds,
  // both early-end switches off.
  for (const p of [hp, mp]) {
    await expect(pressed(p, "じゅんばん")).toBeVisible();
    await expect(pressed(p, "20秒")).toBeVisible();
    await expect(pressed(p, "3")).toBeVisible();
    await expect(toggle(p, "早期決着")).toHaveText("オフ");
    await expect(toggle(p, "ホスト決着")).toHaveText("オフ");
  }

  // Read-only for the member: same panel, every control disabled.
  await expect(mp.getByText("全員に表示", { exact: true })).toBeVisible();
  await expect(segment(mp, "いっせいに")).toBeDisabled();
  await expect(segment(mp, "180秒")).toHaveCount(0); // TURN fields only
  await expect(toggle(mp, "早期決着")).toBeDisabled();

  // The host's mode switch lands on the member's screen — the shared view
  // is server state, not a local echo.
  await segment(hp, "いっせいに").click();
  await expect(pressed(mp, "いっせいに")).toBeVisible();
  await expect(mp.getByText("試合の時間", { exact: true })).toBeVisible();
  await segment(hp, "180秒").click();
  await expect(pressed(mp, "180秒")).toBeVisible();
  // Task 40: the long-session menus are on the shared view too — 5分 on
  // live, 45秒/60秒 on turn, rounds up to 8.
  await segment(hp, "5分").click();
  await expect(pressed(mp, "5分")).toBeVisible();
  await segment(hp, "じゅんばん").click();
  await segment(hp, "45秒").click();
  await expect(pressed(mp, "45秒")).toBeVisible();
  await segment(hp, "8").click();
  await expect(pressed(mp, "8")).toBeVisible();
  await toggle(hp, "早期決着").click();
  await expect(toggle(mp, "早期決着")).toHaveText("オン");
  await toggle(hp, "ホスト決着").click();
  await expect(toggle(mp, "ホスト決着")).toHaveText("オン");

  // A real settings change resets every ready flag — on both screens.
  for (const page of [host, member]) {
    await page.getByRole("button", { name: "準備OKにする" }).click();
  }
  for (const page of [host, member]) await waitReadyCount(page, 2);
  await segment(hp, "60秒").click();
  for (const page of [host, member]) await waitReadyCount(page, 0);
  await expect(pressed(mp, "60秒")).toBeVisible();

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await host.screenshot({ path: join(EVIDENCE_DIR, "task-26-happy.png") });

  // Start consumes exactly the shared settings; the panel leaves with the
  // lobby once the game exists (edits reject at the server too).
  await armContent(host, member);
  for (const page of [host, member]) {
    await page.getByRole("button", { name: "準備OKにする" }).click();
  }
  await waitReadyCount(host, 2);
  await host.getByRole("button", { name: "はじめる" }).click();
  for (const page of [host, member]) {
    await page.getByRole("heading", { name: "試合中" }).waitFor({ timeout: 20_000 });
    await expect(panel(page)).toHaveCount(0);
  }
  const locked = await sendRawError(host, "updateLobby", { mode: "turn" });
  failureLog.push(`post-start updateLobby -> ${locked}`);
  expect(locked).toContain("bad-state");
});

test("failure: host-only, schema, start-mismatch and lock rejections hold", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);

  const cases: Array<[Page, string, unknown, string]> = [
    [member, "updateLobby", { mode: "live" }, "not-host"],
    [host, "updateLobby", { turnSeconds: 15 }, "invalid-envelope"],
    [host, "updateLobby", { rounds: 10 }, "invalid-envelope"],
    [host, "updateLobby", { liveSeconds: 42 }, "invalid-envelope"],
  ];
  for (const [page, type, payload, code] of cases) {
    const message = await sendRawError(page, type, payload);
    failureLog.push(`${type} ${JSON.stringify(payload)} -> ${message}`);
    expect(message).toContain(code);
  }

  // A startGame payload may confirm the shared view, never switch it.
  await sendRaw(host, "updateLobby", { mode: "live", liveSeconds: 60 });
  await expect(pressed(panel(member), "60秒")).toBeVisible();
  const mismatch = await sendRawError(host, "startGame", { mode: "turn" });
  failureLog.push(`startGame {mode:"turn"} vs live view -> ${mismatch}`);
  expect(mismatch).toContain("settings-mismatch");
});
