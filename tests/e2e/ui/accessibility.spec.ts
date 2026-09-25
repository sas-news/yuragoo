// Task 27 acceptance: responsive + accessibility finish for the lobby and
// /play — zero horizontal overflow, axe serious/critical = 0, full keyboard
// operability with visible focus, dialog semantics, non-color choice
// identity, reduced-motion operability, a live non-numeric canvas
// alternative, IME-viewport resilience and long-text robustness.
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  type AxeSummary,
  createRoom,
  expectAxe,
  focusIsVisible,
  gotoPlay,
  insideDialog,
  noHorizontalOverflow,
  overflowCulprits,
  png,
  seat,
  startMatch,
  tabTo,
  tabToText,
  writeEvidence,
} from "./helpers";
import { waitMemberCount } from "../lobby/helpers";

const WIDTHS = [375, 768, 1280] as const;
const CHOICE_IDS = ["c0", "c1", "c2", "c3", "c4", "c5"] as const;
const SYMBOLS = ["○", "◇", "△", "□", "☆", "⬡"] as const;
const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const contexts: BrowserContext[] = [];
const axeRuns: AxeSummary[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(() => writeEvidence("task-27-axe.json", axeRuns));

// Overflow + axe matrix: the host lobby (richest controls) and /play.
for (const width of WIDTHS) {
  test(`happy: lobby ${width}px — no overflow, no serious axe`, async ({ browser }) => {
    const room = await createRoom();
    const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト", width);
    await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー", width);
    await waitMemberCount(host, 2);
    expect(await noHorizontalOverflow(host)).toBe(true);
    await expectAxe(host, axeRuns, "lobby", width);
  });
  test(`happy: /play ${width}px — no overflow, no serious axe`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await gotoPlay(page, "players=6&mode=turn&seed=7&dwell=30&grace=9");
    await startMatch(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await expectAxe(page, axeRuns, "play", width);
  });
}

test("happy: keyboard-only join→lobby and the whole host path", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const ctx = await browser.newContext({ viewport: { width: 768, height: 800 } });
  contexts.push(ctx);
  const host = await ctx.newPage();
  // The name panel is keyboard-first: Tab reaches the field, Enter submits.
  await host.goto(
    `/r/${room.roomId}?api=http%3A%2F%2F127.0.0.1%3A8787&hb=250#${room.inviteSecret}`,
  );
  await tabTo(host, "input");
  expect(await focusIsVisible(host)).toBe(true);
  await host.keyboard.type("キーボードさん");
  await host.keyboard.press("Enter");
  await host.waitForSelector("[data-player-id]", { timeout: 20_000 });
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー", 768);
  await waitMemberCount(host, 2);
  await tabToText(host, "招待リンクをコピー");
  expect(await focusIsVisible(host)).toBe(true);
  await tabTo(host, "textarea");
  await host.keyboard.type("よるのおやつ");
  await tabTo(host, '[data-choice-id="c0"] input');
  await host.keyboard.type("おやつA");
  await tabTo(host, '[data-choice-id="c1"] input');
  await host.keyboard.type("おやつB");
  await tabToText(host, "いっせいに");
  await host.keyboard.press("Enter");
  await expect(
    member.getByRole("button", { name: "いっせいに", exact: true, pressed: true }),
  ).toBeVisible({ timeout: 20_000 });
  // Member: settings segments are disabled (skipped by Tab), ready works.
  expect(await member.locator('[data-settings="panel"] button').first().isDisabled()).toBe(true);
  await tabToText(member, "準備OKにする");
  await member.keyboard.press("Enter");
  await tabToText(host, "準備OKにする");
  await host.keyboard.press("Enter");
  await host.waitForSelector("[data-player-id][data-ready='true']", { timeout: 20_000 });
  // If the gate stays closed this surfaces its reason instead of a bare
  // timeout: disabled buttons are unreachable by Tab by design.
  const start = host.getByRole("button", { name: "はじめる" });
  try {
    await expect(start).toBeEnabled({ timeout: 20_000 });
  } catch {
    const reasons = await host.locator("footer p").allTextContents();
    throw new Error(`start gate stayed closed: ${JSON.stringify(reasons)}`);
  }
  await tabToText(host, "はじめる");
  await host.keyboard.press("Enter");
  await host.getByRole("heading", { name: "試合中" }).waitFor({ timeout: 20_000 });
});

test("happy: keyboard-only /play — setup, post, result, rematch", async ({ page }) => {
  await gotoPlay(page, "players=2&mode=turn&rounds=1&seed=7&dwell=30&grace=9");
  await tabTo(page, '[data-testid="start-button"]');
  expect(await focusIsVisible(page)).toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "playing");
  await tabTo(page, '[data-testid="game-input"]');
  await page.keyboard.type("ひとことめ");
  await page.keyboard.press("Enter"); // IME-safe submit path
  await expect(page.getByTestId("feed-item")).toHaveCount(1);
  await tabTo(page, '[data-testid="game-input"]');
  await page.keyboard.type("ふたことめ");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("feed-item")).toHaveCount(2);
  await expect(page.getByTestId("result-overlay")).toBeVisible({ timeout: 20_000 });
  expect(await insideDialog(page)).toBe(true); // focus moved into the dialog
  await tabTo(page, '[data-testid="rematch-button"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => window.__localBridge?.epoch() === 1 && window.__localBridge?.state()?.phase === "playing",
  );
});

test("happy: leave confirm traps focus, Esc closes, focus returns", async ({ browser }) => {
  const room = await createRoom();
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー", 375);
  await member.getByRole("button", { name: "へやを出る" }).click();
  const dialog = member.getByTestId("leave-confirm");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 6; i += 1) {
    // Focus stays trapped across Tab and Shift+Tab.
    expect(await insideDialog(member)).toBe(true);
    await member.keyboard.press(i % 2 === 0 ? "Tab" : "Shift+Tab");
  }
  await member.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(
    await member.evaluate(() => document.activeElement?.textContent?.includes("へやを出る")),
  ).toBe(true);
  // Reopen and confirm for real this time.
  await member.getByRole("button", { name: "へやを出る" }).click();
  await member.getByTestId("leave-confirm-yes").click();
  await expect(member.getByText("へやを出ました。")).toBeVisible();
});

test("failure: 360px, 200% zoom, soft keyboard — dock and controls hold", async ({ browser }) => {
  const room = await createRoom();
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー", 360);
  expect(await noHorizontalOverflow(member)).toBe(true);
  // 200% browser zoom at a 360px viewport ≈ a 180-CSS-pixel viewport — the
  // honest emulation, since zoom divides the reported CSS width.
  await member.setViewportSize({ width: 180, height: 700 });
  expect(await overflowCulprits(member)).toEqual([]);
  const ready = member.getByRole("button", { name: "準備OKにする" });
  await ready.scrollIntoViewIfNeeded();
  await ready.click();
  await member.waitForSelector("[data-player-id][data-ready='true']", { timeout: 20_000 });
  await png(member, "task-27-failure.png");
  // Approximate an open IME by shrinking the layout viewport — the page is
  // 100dvh-flex, so the dock must stay inside the new visual bottom.
  const play = await contexts[0]?.newPage();
  if (play === undefined) return;
  await play.setViewportSize({ width: 360, height: 280 });
  await gotoPlay(play, "players=2&mode=turn&seed=7&dwell=30&grace=9");
  await startMatch(play);
  expect(await noHorizontalOverflow(play)).toBe(true);
  const dock = await play.locator("form[aria-label='投稿ドック']").boundingBox();
  expect(dock).not.toBeNull();
  expect((dock?.y ?? 0) + (dock?.height ?? 0)).toBeLessThanOrEqual(282);
  await play.getByTestId("game-input").fill("みえるよ");
  await play.getByTestId("send-button").click();
  await expect(play.getByTestId("feed-item")).toHaveCount(1);
});

test("happy: six seats — symbol+label identity, long text, no overflow", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト", 375);
  const member = await seat(
    browser,
    contexts,
    room.roomId,
    room.inviteSecret,
    "すごくながいなまえのプレイヤー",
    375,
  );
  for (const name of ["さん", "よん", "ごう", "ろく"]) {
    await seat(browser, contexts, room.roomId, room.inviteSecret, name, 375);
  }
  await waitMemberCount(host, 6);
  const long = "とてもながいこたえのぶんしょうですがぜんぶよめます"; // ~40 with suffix
  for (const [i, id] of CHOICE_IDS.entries()) {
    await host.locator(`[data-choice-id="${id}"] input`).fill(`${long}${i}`);
    await expect(host.locator(`[data-choice-id="${id}"] input`)).toHaveAccessibleName(
      new RegExp(`選択肢 ${SYMBOLS[i]}${LETTERS[i]}`),
    );
  }
  for (const [i, id] of CHOICE_IDS.entries()) {
    const row = member.locator(`[data-choice-id="${id}"]`);
    await expect(row).toContainText(`${long}${i}`, { timeout: 20_000 });
    const name = await row.getAttribute("aria-label");
    expect(name).toContain(SYMBOLS[i] ?? "");
    expect(name).toContain(LETTERS[i] ?? "");
    expect(name).toContain(`${long}${i}`);
    // The row wraps its full label instead of overflowing.
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await noHorizontalOverflow(member)).toBe(true);
  await png(member, "task-27-happy.png");
});

test("happy: reduced motion keeps /play operable and the status updates", async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 375, height: 700 },
  });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await gotoPlay(page, "players=2&mode=turn&seed=7&dwell=30&grace=9");
  await startMatch(page);
  const status = page.getByTestId("creature-status");
  const before = await status.textContent();
  await page.getByTestId("game-input").fill("かんがえて");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("feed-item")).toHaveCount(1);
  await page.waitForFunction(
    (prev) => document.querySelector('[data-testid="creature-status"]')?.textContent !== prev,
    before,
    { timeout: 10_000 },
  );
  expect(await status.textContent()).not.toMatch(/[0-9]/); // words only
  const chip = page.locator("[data-testid^='seat-']").first();
  expect(await chip.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
