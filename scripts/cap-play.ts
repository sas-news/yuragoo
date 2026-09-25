// Quick /play screenshot helper for visual iteration (dev server on :5173).
// Usage: bun scripts/cap-play.ts <outDir> [w] [h]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const dir = process.argv[2] ?? ".";
const w = Number(process.argv[3] ?? 1280);
const h = Number(process.argv[4] ?? 720);
mkdirSync(dir, { recursive: true });

interface LocalBridge {
  state(): {
    turnOrder: string[];
    turnIndex: number;
    posts: { postId: string }[];
    phase: string;
  } | null;
  dispatch(action: unknown): void;
  layout(): unknown;
}

// page.evaluate/waitForFunction callbacks run in the browser — read the
// bridge with the `(window as unknown as { __localBridge?: LocalBridge })`
// inline cast below (helpers can't cross the serialization boundary).
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: w, height: h } });

const post = (text: string) =>
  page.evaluate((t) => {
    const b = (window as unknown as { __localBridge?: LocalBridge }).__localBridge;
    if (b === undefined) throw new Error("no local bridge");
    const s = b.state();
    if (s === null) throw new Error("no state");
    const seat = s.turnOrder[s.turnIndex];
    b.dispatch({ type: "post", playerId: seat, text: t, nowMs: Date.now() });
    const pid = b.state()?.posts.at(-1)?.postId ?? "";
    b.dispatch({ type: "evaluated", postId: pid });
    return pid;
  }, text);

// --- setup screen ---
await page.goto("http://127.0.0.1:5173/play");
await page.locator("[data-testid='local-game']").waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: `${dir}/01-setup.png` });

// --- start a 4-player TURN match ---
await page.getByRole("button", { name: "はじめる" }).click();
await page.waitForFunction(
  () => (window as unknown as { __localBridge?: LocalBridge }).__localBridge?.layout() !== null,
);
await page.locator("[data-testid^='seat-']").first().waitFor({ state: "attached" });
await page.waitForTimeout(1600); // creature settles
await page.screenshot({ path: `${dir}/02-idle.png` });

// --- a few posts, keep bubbles up ---
await post("プリンがいいな");
await page.waitForTimeout(600);
await post("むすびもすてがたい");
await page.waitForTimeout(600);
await post("ゼリーきになるー");
await page.waitForTimeout(900);
await page.screenshot({ path: `${dir}/03-bubbles.png` });

// --- run out the match -> result ---
for (let i = 0; i < 9; i += 1) {
  await post(`たべたい${i}`);
  await page.waitForTimeout(250);
}
await page
  .waitForFunction(
    () =>
      (window as unknown as { __localBridge?: LocalBridge }).__localBridge?.state()?.phase ===
      "finished",
    {
      timeout: 20000,
    },
  )
  .catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: `${dir}/04-result.png` });

await browser.close();
console.log("done", dir);
