// Repro: does the result dialog's "ロビーにもどる" actually return every
// connected client to the lobby? Drives a real 2-player TURN match to
// finished through the running dev stack, clicks the button on ONE
// member, then asserts both pages land back on the lobby UI.
import { chromium, type Page } from "@playwright/test";

const API = process.env.REPRO_API ?? "http://127.0.0.1:8787";
const WEB = process.env.REPRO_WEB ?? "http://127.0.0.1:5173";
const url = (roomId: string, secret: string, name: string) =>
  `${WEB}/r/${roomId}?api=${encodeURIComponent(API)}&hb=250&name=${encodeURIComponent(name)}#${secret}`;

const res = await fetch(`${API}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const room = (await res.json()) as { roomId: string; inviteSecret: string };
console.log("room:", room.roomId.slice(0, 8));
const browser = await chromium.launch();
const mk = async (name: string) => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || t.includes("[ws]")) console.log(`[${name}]`, t.slice(0, 200));
  });
  await page.goto(url(room.roomId, room.inviteSecret, name));
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};
const host = await mk("ホスト");
const member = await mk("メンバー");
const all: Page[] = [host, member];

await host.locator("textarea").fill("浜辺で貝殻を見つけた。どうする？");
const rows = host.locator("[data-choice-id] input");
for (let i = 0; i < (await rows.count()); i += 1) {
  await rows.nth(i).fill(["拾う", "眺める", "逃げる"][i] ?? `えらぶ${i + 1}`);
}
// 1 round x 10s turns: the fastest path to a finished match.
const roundSelect = host.locator('select:has-text("回")').first();
if ((await roundSelect.count()) > 0) await roundSelect.selectOption("1");
const turnSelect = host.locator('select:has-text("秒")').first();
if ((await turnSelect.count()) > 0) await turnSelect.selectOption("10秒");
for (const p of all) await p.getByRole("button", { name: "準備OKにする" }).click();
await host.waitForTimeout(600);
await host.getByRole("button", { name: "はじめる" }).click();
await host.waitForTimeout(1200);
console.log("started");

// Whichever seat holds the turn passes until the result dialog opens.
for (let i = 0; i < 40; i += 1) {
  const outcome = await host
    .locator('[data-testid="back-to-lobby"]')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (outcome) break;
  let acted = false;
  for (const p of all) {
    const mine = await p.locator("[data-turn-self]").count();
    if (mine > 0) {
      const pass = p.getByRole("button", { name: "パスする" });
      if ((await pass.count()) > 0) {
        await pass.click();
        acted = true;
      }
    }
  }
  if (!acted) await host.waitForTimeout(500);
}
// Poll past the settle window: the finish broadcast should arrive within
// settleSeconds; keep sampling the feed + dialog for 25s so a missing
// alarm shows up as a stuck "complete" phase.
for (let t = 0; t < 25; t += 1) {
  const dlg = await host.getByTestId("back-to-lobby").count();
  if (dlg > 0) break;
  await host.waitForTimeout(1000);
  if (t % 4 === 3) {
    const tail = await host
      .locator('[data-testid="feed-line"]')
      .allTextContents()
      .then((l) => l.slice(-3));
    console.log(`t+${t + 1}s feed:`, JSON.stringify(tail));
  }
}
console.log("finished?", (await host.getByTestId("back-to-lobby").count()) > 0);
await host.waitForTimeout(1000);
console.log(
  "feed tail:",
  JSON.stringify(
    await host
      .locator('[data-testid="feed-line"]')
      .allTextContents()
      .then((l) => l.slice(-6)),
  ),
);

// One member presses it — BOTH pages must land on the lobby view.
await member.getByTestId("back-to-lobby").click();
await host.waitForTimeout(1500);
for (const [i, p] of all.entries()) {
  const ready = await p.getByRole("button", { name: "準備OKにする" }).count();
  const dlg = await p.getByTestId("back-to-lobby").count();
  const err = await p.locator('[role="alert"], .error, [data-error]').allTextContents();
  console.log(
    `page${i}: readyBtn=${ready} resultDlg=${dlg} err=${JSON.stringify(err.slice(0, 3))}`,
  );
}
await host.screenshot({ path: "tmp/backtolobby-host.png" });
await member.screenshot({ path: "tmp/backtolobby-member.png" });
await browser.close();
