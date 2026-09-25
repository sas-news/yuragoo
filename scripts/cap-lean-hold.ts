// Repro: post a directional text, then watch the creature-status line —
// it must hold "かんがえている" through the eval window and land on
// "のほうへ" (a lean), NEVER passing through "おちついている" (centered).
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
const browser = await chromium.launch();
const mk = async (name: string) => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  await page.addInitScript(() => {
    const log: unknown[] = [];
    (window as unknown as { __wsLog: unknown[] }).__wsLog = log;
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(u: string | URL, p?: string | string[]) {
        super(u, p);
        this.addEventListener("message", (ev) => {
          if (typeof ev.data === "string" && ev.data.includes("decision")) {
            try {
              log.push(JSON.parse(ev.data));
            } catch {}
          }
        });
      }
    } as typeof WebSocket;
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

// Poll the status line every 250ms for 10s — record the transition chain.
const seen: string[] = [];
for (let i = 0; i < 40; i += 1) {
  const text = (await host.getByTestId("creature-status").textContent())?.trim() ?? "";
  if (seen[seen.length - 1] !== text) seen.push(`t+${i * 0.25}s ${text}`);
  await host.waitForTimeout(250);
}
console.log("status chain:");
for (const line of seen) console.log("  ", line);
const flat = seen.join("\n");
console.log(
  "verdict:",
  flat.includes("のほうへ") && !flat.includes("おちついている") ? "PASS" : "CHECK",
);
const feed = await host.locator("[data-testid='feed-line']").allTextContents();
console.log("feed:", JSON.stringify(feed.slice(-8)));
const log = (await host.evaluate(() => (window as unknown as { __wsLog: unknown[] }).__wsLog)) as {
  type?: string;
  payload?: unknown;
}[];
for (const m of log) console.log("ws:", m.type, JSON.stringify(m.payload ?? {}).slice(0, 200));
await browser.close();
