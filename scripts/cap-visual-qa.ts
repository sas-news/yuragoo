// Task 16 visual-QA captures for /play: 375 / 768 / 1280 px viewports across
// the five review states (default, focus, error, loading, reduced-motion).
// Dev server on :5173 must be running. Usage:
//   bun scripts/cap-visual-qa.ts <outDir>
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

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

// page.evaluate/waitForFunction callbacks run in the browser — the bridge
// is read with `(window as unknown as { __localBridge?: LocalBridge })`.
const dir = process.argv[2] ?? ".";
mkdirSync(dir, { recursive: true });

const WIDTHS = [375, 768, 1280] as const;
const HEIGHT = 700;

const post = (page: Page, text: string) =>
  page.evaluate((t: string) => {
    const b = (window as unknown as { __localBridge?: LocalBridge }).__localBridge;
    if (b === undefined) throw new Error("no local bridge");
    const s = b.state();
    if (s === null) throw new Error("no state");
    const seat = s.turnOrder[s.turnIndex];
    b.dispatch({ type: "post", playerId: seat, text: t, nowMs: Date.now() });
    const pid = b.state()?.posts.at(-1)?.postId ?? "";
    b.dispatch({ type: "evaluated", postId: pid });
  }, text);

const startPlaying = async (page: Page) => {
  await page.goto("http://127.0.0.1:5173/play?players=4&mode=turn&seed=7&dwell=30&grace=9");
  await page.locator("[data-testid='setup-panel']").waitFor();
  await page.getByTestId("start-button").click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __localBridge?: LocalBridge }).__localBridge?.state()?.phase ===
      "playing",
  );
  await page.waitForFunction(
    () => (window as unknown as { __localBridge?: LocalBridge }).__localBridge?.layout() !== null,
  );
  await page.waitForTimeout(1200);
};

const browser = await chromium.launch();
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: HEIGHT } });
  const page = await ctx.newPage();

  // default: playing with one bubble up
  await startPlaying(page);
  await post(page, "プリンにきめた");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/qa-${w}-default.png` });

  // focus: keyboard focus ring on the send button
  await page.getByTestId("send-button").focus();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${dir}/qa-${w}-focus.png` });

  // error: over-limit draft shows 文字数オーバー + red counter
  await page.getByTestId("game-input").fill("あ".repeat(150));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${dir}/qa-${w}-error.png` });
  await page.getByTestId("game-input").fill("");
  await ctx.close();
}

// loading: pending eval state in the dock (evalDelay stretches the provider)
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: HEIGHT } });
  const page = await ctx.newPage();
  await page.goto(
    "http://127.0.0.1:5173/play?players=4&mode=turn&seed=7&evalDelay=4000&dwell=30&grace=9",
  );
  await page.locator("[data-testid='setup-panel']").waitFor();
  await page.getByTestId("start-button").click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __localBridge?: LocalBridge }).__localBridge?.state()?.phase ===
      "playing",
  );
  await page.waitForFunction(
    () => (window as unknown as { __localBridge?: LocalBridge }).__localBridge?.layout() !== null,
  );
  await page.waitForTimeout(1000);
  await page.getByTestId("game-input").fill("まってね");
  await page.getByTestId("send-button").click();
  await page.waitForTimeout(400); // pending eval in flight
  await page.screenshot({ path: `${dir}/qa-${w}-loading.png` });
  await ctx.close();
}

// reduced-motion: emulate prefers-reduced-motion while a bubble is up
for (const w of WIDTHS) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: HEIGHT },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  await startPlaying(page);
  await post(page, "ひかえめなこえ");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/qa-${w}-reduced.png` });
  await ctx.close();
}

await browser.close();
console.log("done", dir);
