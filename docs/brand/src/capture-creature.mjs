// Captures the REAL rendered creature from /dev/creature (e2e build) at
// 2x DPI — poses driven through window.__YURAGOO_LAB_E2E__.set(weights,
// expression) so the stretch is the actual contour physics, not a mock.
// Output: docs/brand/src/captures/*.png, composited by make-brand.mjs.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const capDir = resolve(dirname(fileURLToPath(import.meta.url)), "captures");
mkdirSync(capDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:4180/dev/creature", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__YURAGOO_LAB_E2E__ !== undefined);
const stage = page.locator(".stageWrap, [class*=stageWrap]").first();
await stage.waitFor();
await page.waitForTimeout(2200);

const set = (weights, expression) =>
  page.evaluate(([w, e]) => window.__YURAGOO_LAB_E2E__.set(w, e), [weights, expression]);

const shots = [
  { name: "rest", weights: [25, 25, 25, 25], expr: "rest", settle: 1600 },
  { name: "pull", weights: [8, 70, 12, 10], expr: "engaged", settle: 1500 },
  { name: "stretch", weights: [3, 92, 3, 2], expr: "adhering", settle: 1500 },
];
// Crop boxes (device px on the 2x stage capture): creature + its ground
// shadow, excluding the orbit posts and the bottom-right status chip.
const crops = {
  rest: "crop=680:680:430:150",
  pull: "crop=680:680:820:190",
  stretch: "crop=760:640:780:190",
};
for (const s of shots) {
  await set(s.weights, s.expr);
  await page.waitForTimeout(s.settle);
  const raw = resolve(capDir, `creature-${s.name}-raw.png`);
  await stage.screenshot({ path: raw });
  execSync(
    `ffmpeg -y -i "${raw}" -vf "${crops[s.name]}" "${resolve(capDir, `creature-${s.name}.png`)}"`,
  );
  console.log("wrote creature-" + s.name + ".png");
}
await browser.close();
