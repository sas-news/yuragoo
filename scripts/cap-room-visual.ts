// Visual QA for the room screen: captures the in-game view at wide and
// narrow widths after a post has been evaluated (creature leaning).
// Dev server :5173 + worker :8790 must be running. Usage:
//   bun scripts/cap-room-visual.ts <outDir>
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const API = process.env.REPRO_API ?? "http://127.0.0.1:8790";
const WEB = process.env.REPRO_WEB ?? "http://127.0.0.1:5173";
const dir = process.argv[2] ?? ".";
mkdirSync(dir, { recursive: true });
const url = (roomId: string, secret: string, name: string) =>
  `${WEB}/r/${roomId}?api=${encodeURIComponent(API)}&name=${encodeURIComponent(name)}#${secret}`;

const res = await fetch(`${API}/api/rooms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const room = (await res.json()) as { roomId: string; inviteSecret: string };
const browser = await chromium.launch();

const mk = async (name: string, width: number): Promise<Page> => {
  const ctx = await browser.newContext({ viewport: { width, height: 700 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  await page.goto(url(room.roomId, room.inviteSecret, name));
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};

const host = await mk("ホスト", 1280);
const member = await mk("メンバー", 1280);

await host.locator("textarea").fill("浜辺で貝殻を見つけた。どうする？");
const rows = host.locator("[data-choice-id] input");
for (let i = 0; i < (await rows.count()); i += 1) {
  await rows.nth(i).fill(["拾う", "眺める"][i] ?? `えらぶ${i + 1}`);
}
for (const p of [host, member]) await p.getByRole("button", { name: "準備OKにする" }).click();
await host.waitForTimeout(600);
await host.getByRole("button", { name: "はじめる" }).click();
await host.waitForTimeout(1200);

const owner = async (): Promise<Page> => {
  for (const p of [host, member]) {
    if ((await p.locator("[data-turn-self]").count()) > 0) return p;
  }
  return host;
};
const poster = await owner();
await poster.getByTestId("game-input").fill("拾って匂いをかぐ");
await poster.getByTestId("send-button").click();

// Wait for the lean status to land, then settle a beat for the pull to read.
await host.waitForFunction(
  () =>
    document.querySelector("[data-testid='creature-status']")?.textContent?.includes("のほうへ"),
  { timeout: 15_000 },
);
await host.waitForTimeout(1200);
await host.screenshot({ path: `${dir}/room-1280.png` });
await member.screenshot({ path: `${dir}/room-1280-member.png` });

// Narrow: resize the host page to a phone-width viewport.
await host.setViewportSize({ width: 375, height: 700 });
await host.waitForTimeout(700);
await host.screenshot({ path: `${dir}/room-375.png` });

await browser.close();
console.log("done", dir);
