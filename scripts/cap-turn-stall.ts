// Repro: 2-player TURN match — post, pass, then let a turn time out.
// Dumps data-turn-player on both pages after each step.
import { chromium, type Page } from "@playwright/test";

const API = "http://127.0.0.1:8787";
const url = (roomId: string, secret: string, name: string) =>
  `http://127.0.0.1:5173/r/${roomId}?api=${encodeURIComponent(API)}&hb=250&name=${encodeURIComponent(name)}#${secret}`;

const res = await fetch(`${API}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const room = (await res.json()) as { roomId: string; inviteSecret: string };
const browser = await chromium.launch();
const mk = async (name: string) => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${name}] console.error`, m.text());
  });
  await page.goto(url(room.roomId, room.inviteSecret, name));
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};
const host = await mk("host");
const member = await mk("member");

await host.locator("textarea").fill("ターン停滞の再現");
const rows = host.locator("[data-choice-id] input");
for (let i = 0; i < (await rows.count()); i += 1) await rows.nth(i).fill(`えらぶ${i + 1}`);

// Settings: TURN mode, 10s turns, 3 rounds — find the pickers by label.
const settingsSection = host
  .locator('section[aria-label*="設定"], [data-testid*="settings"]')
  .first();
console.log("settings section count:", await settingsSection.count());
// Dump all selects/buttons in lobby to find turn-seconds control.
const selects = await host.locator("select").all();
for (const s of selects) {
  console.log("select:", await s.getAttribute("aria-label"), await s.getAttribute("name"));
}
// Try to set turn seconds via any select containing 10.
for (const s of selects) {
  const opts = await s.locator("option").allTextContents();
  console.log("opts:", opts.join(","));
  const opt10 = opts.find((o) => o.includes("10"));
  if (opt10 !== undefined) await s.selectOption({ label: opt10 });
}

for (const p of [host, member]) await p.getByRole("button", { name: "準備OKにする" }).click();
await host.waitForTimeout(600);
await host.getByRole("button", { name: "はじめる" }).click();
await host.locator("[data-turn-player]").waitFor({ timeout: 15_000 });

const turnOf = async (p: Page) =>
  p.evaluate(() => ({
    turn: document.querySelector("[data-turn-player]")?.getAttribute("data-turn-player"),
    self: document.querySelector("[data-turn-self]") !== null,
    hud: document.querySelector("main")?.textContent?.slice(0, 80),
  }));
const dump = async (tag: string) => {
  console.log(`--- ${tag}`);
  console.log("  host  :", JSON.stringify(await turnOf(host)));
  console.log("  member:", JSON.stringify(await turnOf(member)));
  const feed = await host.locator('[data-testid="feed-line"]').allTextContents();
  console.log("  feed  :", JSON.stringify(feed.slice(-6)));
};
const owner = async (): Promise<Page> => {
  for (const p of [host, member]) if ((await p.locator("[data-turn-self]").count()) > 0) return p;
  throw new Error("no owner");
};

await dump("after start");
const t1 = await owner();
console.log("turn1 owner is", (await turnOf(t1)).hud?.slice(0, 30));
await t1.getByTestId("game-input").fill("テスト投稿です");
await t1.getByTestId("send-button").click();
await host.waitForTimeout(1500);
await dump("after post");

const t2 = await owner();
await t2.getByRole("button", { name: "パスする" }).click();
await host.waitForTimeout(1500);
await dump("after pass");

// Now idle through a full timeout (turn seconds from settings; poll 40s).
console.log("idling through timeout...");
const before = (await turnOf(host)).turn;
let moved = false;
for (let i = 0; i < 45; i += 1) {
  await host.waitForTimeout(1000);
  const now = (await turnOf(host)).turn;
  if (now !== before) {
    console.log(`turn moved at +${i + 1}s -> ${now}`);
    moved = true;
    break;
  }
}
if (!moved) console.log("TURN DID NOT MOVE within 45s — stall reproduced");
await dump("after timeout window");
await host.screenshot({ path: ".omo/shots/turn-stall.png" });
await member.screenshot({ path: ".omo/shots/turn-stall-member.png" });
await browser.close();
