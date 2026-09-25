// Repro 2: capture the actual decisionUpdated payloads off the wire and
// verify they carry non-uniform probabilities keyed to the room's own
// choice ids (c0..cN) — i.e. Jev output really steers the creature.
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
  await rows.nth(i).fill(["拾う", "眺める", "逃げる"][i] ?? `えらぶ${i + 1}`);
}
for (const p of [host, member]) await p.getByRole("button", { name: "準備OKにする" }).click();
await host.waitForTimeout(600);
await host.getByRole("button", { name: "はじめる" }).click();
await host.waitForTimeout(1200);

const post = async (p: Page, text: string) => {
  await p.getByTestId("game-input").fill(text);
  await p.getByTestId("send-button").click();
};
// TURN mode: post on the current owner's page.
const owner = async (): Promise<Page> => {
  for (const p of [host, member]) {
    if ((await p.locator("[data-turn-self]").count()) > 0) return p;
  }
  return host;
};
await post(await owner(), "拾って匂いをかぐ");
await host.waitForTimeout(2500);
await post(await owner(), "そっと逃げる");

for (let i = 0; i < 15; i += 1) {
  await host.waitForTimeout(1000);
  const log = (await host.evaluate(
    () => (window as unknown as { __wsLog: unknown[] }).__wsLog,
  )) as {
    payload?: { event?: { type?: string } };
  }[];
  const dists = log
    .map((m) => (m as { payload?: { distribution?: unknown } }).payload?.distribution)
    .filter(Boolean);
  if (dists.length >= 2 || i === 14) {
    console.log(`t+${i + 1}s decision frames:`, log.length);
    for (const m of log) console.log(JSON.stringify(m.payload ?? m).slice(0, 300));
    break;
  }
}
await browser.close();
