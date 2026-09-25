// Repro: start a 2-player TURN room match and capture page errors/console.
// Needs dev servers: worker on :8787, vite on :5173.
import { chromium } from "@playwright/test";

const API = "http://127.0.0.1:8787";
const url = (roomId: string, secret: string, name: string) =>
  `http://127.0.0.1:5173/r/${roomId}?api=${encodeURIComponent(API)}&hb=250&name=${encodeURIComponent(name)}#${secret}`;

const res = await fetch(`${API}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const room = (await res.json()) as { roomId: string; inviteSecret: string };
console.log("room", room.roomId);

const browser = await chromium.launch();
const errors: string[] = [];
const mk = async (name: string) => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    errors.push(`[${name}] pageerror: ${e.message}\n${e.stack ?? ""}`);
    console.log(`[${name}] PAGEERROR`, e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${name}] console.error`, m.text());
  });
  await page.goto(url(room.roomId, room.inviteSecret, name));
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};

const host = await mk("host");
const member = await mk("member");

// Fill scenario + 2 choice labels on host, ready both, start.
await host.locator("textarea").fill("クラッシュ再現シナリオ");
const rows = host.locator("[data-choice-id] input");
const n = await rows.count();
for (let i = 0; i < n; i += 1) await rows.nth(i).fill(`こたえ${i + 1}`);
await host.waitForTimeout(800);
for (const p of [host, member]) {
  await p.getByRole("button", { name: "準備OKにする" }).click();
}
await host.waitForTimeout(800);
await host.getByRole("button", { name: "はじめる" }).click();
await host.waitForTimeout(4000);

for (const [name, p] of [
  ["host", host],
  ["member", member],
] as const) {
  const info = await p.evaluate(() => ({
    mainHtml: document.querySelector("main")?.outerHTML.slice(0, 400) ?? "NO MAIN",
    turnPlayer: document.querySelector("[data-turn-player]")?.getAttribute("data-turn-player"),
    turnSelf: document.querySelector("[data-turn-self]") !== null,
    rootChildren: document.getElementById("root")?.childElementCount ?? -1,
  }));
  console.log(`[${name}]`, JSON.stringify(info));
}
await host.screenshot({ path: ".omo/shots/crash-host.png" });
console.log("errors:", errors.length);
for (const e of errors.slice(0, 4)) console.log(e);
await browser.close();
