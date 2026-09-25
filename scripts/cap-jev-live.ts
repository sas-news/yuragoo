// Repro: does the room decision pipeline actually reach Jev on dev?
// Drives a real 2-player LIVE match through the running dev stack and
// watches the feed for "かたより" (decisionUpdated) vs "もらえなかった"
// (decisionFailed). Never prints secrets.
import { chromium, type Page } from "@playwright/test";

const API = process.env.REPRO_API ?? "http://127.0.0.1:8787";
const WEB = process.env.REPRO_WEB ?? "http://127.0.0.1:5173";
const url = (roomId: string, secret: string, name: string) =>
  `${WEB}/r/${roomId}?api=${encodeURIComponent(API)}&name=${encodeURIComponent(name)}#${secret}`;

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
    if (m.type() === "error") console.log(`[${name}] console.error`, m.text().slice(0, 200));
  });
  await page.goto(url(room.roomId, room.inviteSecret, name));
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};
const host = await mk("ホスト");
const member = await mk("メンバー");

await host.locator("textarea").fill("浜辺で貝殻を見つけた。どうする？");
const rows = host.locator("[data-choice-id] input");
for (let i = 0; i < (await rows.count()); i += 1) {
  await rows.nth(i).fill(["拾う", "眺める", "逃げる"][i] ?? `えらぶ${i + 1}`);
}
// LIVE mode so both can post without turn tracking.
const selects = await host.locator("select").all();
for (const s of selects) {
  const label = (await s.getAttribute("aria-label")) ?? "";
  if (label.includes("モード") || label.includes("mode")) {
    const live = (await s.locator("option").allTextContents()).find((o) =>
      o.toLowerCase().includes("live"),
    );
    if (live !== undefined) await s.selectOption({ label: live });
  }
}
for (const p of [host, member]) await p.getByRole("button", { name: "準備OKにする" }).click();
await host.waitForTimeout(600);
await host.getByRole("button", { name: "はじめる" }).click();
await host.waitForTimeout(1500);
console.log("started");

const feedOf = (p: Page) => p.locator('[data-testid="feed-line"]').allTextContents();
await host.getByTestId("game-input").fill("拾って匂いをかぐ");
await host.getByTestId("send-button").click();
await member.getByTestId("game-input").fill("そっと逃げる");
await member.getByTestId("send-button").click();
console.log("posted 2");

for (let i = 0; i < 20; i += 1) {
  await host.waitForTimeout(1000);
  const feed = await feedOf(host);
  const hit = feed.filter((l) => l.includes("かたより") || l.includes("もらえなかった"));
  if (hit.length >= 2 || i === 19) {
    console.log(`t+${i + 1}s feed-tail:`, JSON.stringify(feed.slice(-8)));
    if (hit.length >= 2) break;
  }
}
await browser.close();
