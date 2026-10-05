// Records ~8s of the live /play session (the creature reacting to pointer
// pulls) into a webm, then ffmpeg converts it to the Discord preview spec:
// 640x360 mp4, <= 10s, <= 0.5MB. Run with `vite preview` on :4180.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const brandDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const videoDir = resolve(brandDir, "raw-video");

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 640, height: 360 },
  recordVideo: { dir: videoDir, size: { width: 640, height: 360 } },
});
const page = await ctx.newPage();
await page.goto("http://localhost:4180/play", { waitUntil: "networkidle" });
// /play opens on a settings panel — start the session first so the
// creature stage is what the preview actually shows.
await page.getByRole("button", { name: "はじめる" }).click();
await page.waitForTimeout(1600);
// Pull the creature: drag from center outward in a few directions so the
// blob visibly sways toward the cursor — the "ひとことで引っ張る" motion.
for (const [dx, dy] of [
  [140, -60],
  [-150, 30],
  [110, 70],
  [-80, -80],
  [60, 40],
]) {
  await page.mouse.move(320, 150);
  await page.mouse.down();
  await page.mouse.move(320 + dx, 150 + dy, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}
await page.waitForTimeout(900);
await ctx.close();
await browser.close();

const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
const out = resolve(brandDir, "preview-640x360.mp4");
execSync(
  `ffmpeg -y -i "${join(videoDir, webm)}" -vf "scale=640:360" -c:v libx264 -preset slow -crf 30 -movflags +faststart -an "${out}"`,
);
const kb = Math.round(statSync(out).size / 1024);
console.log(`wrote preview-640x360.mp4 (${kb} KB)`);
if (kb > 512) console.warn("over Discord's 0.5MB cap — raise crf");
