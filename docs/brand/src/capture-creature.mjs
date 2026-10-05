// Captures the REAL rendered creature from /dev/creature (e2e build) at
// 2x DPI — poses driven through window.__YURAGOO_LAB_E2E__.set(weights,
// expression) so the stretch is the actual contour physics, not a mock.
// Crop boxes are auto-detected from body-colored pixels (longest dense
// column/row run = the creature blob; orbit posts/lines don't qualify),
// centered on the body and extended downward to include the ground shadow.
// Output: docs/brand/src/captures/*.png, composited by make-brand.mjs.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const capDir = resolve(dirname(fileURLToPath(import.meta.url)), "captures");
mkdirSync(capDir, { recursive: true });

const pngSize = (file) => {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

// Returns {cx, cy, w, h} of the creature body inside a stage screenshot —
// the longest run of columns/rows dense in mint-teal body pixels.
const bodyBox = (rawPath, rgbPath) => {
  const { w, h } = pngSize(rawPath);
  execSync(`ffmpeg -y -i "${rawPath}" -f rawvideo -pix_fmt rgb24 "${rgbPath}"`);
  const px = readFileSync(rgbPath);
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const col = new Array(cw).fill(0);
  const row = new Array(ch).fill(0);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 3;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // mint body (blends lighter over the paper bg) .. belly teal;
      // rejects cream bg, pale guide lines, shadow mauve, ink text
      if (g > 150 && g < 250 && r > 50 && r < 190 && b > 110 && b < 235 && g > r + 30) {
        col[x >> 1]++;
        row[y >> 1]++;
      }
    }
  }
  const run = (counts, min) => {
    let best = { s: 0, len: 0 };
    let cur = -1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= min) {
        if (cur < 0) cur = i;
      } else if (cur >= 0) {
        if (i - cur > best.len) best = { s: cur, len: i - cur };
        cur = -1;
      }
    }
    if (cur >= 0 && counts.length - cur > best.len) best = { s: cur, len: counts.length - cur };
    return best;
  };
  // Dense = many body pixels in that half-res column/row (the blob is the
  // longest such run; thin lines and small posts never reach it).
  const cx = run(col, 40);
  const cy = run(row, 40);
  return { x: cx.s * 2, y: cy.s * 2, w: cx.len * 2, h: cy.len * 2, imgW: w, imgH: h };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:4180/dev/creature", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__YURAGOO_LAB_E2E__ !== undefined);
const stage = page.locator(".stageWrap, [class*=stageWrap]").first();
await stage.waitFor();
// Hide the creature-status chip ("◇B のほうへ …") — it's half-cut at crop
// edges in stills. The video clip keeps it (it narrates the pull live).
await page.addStyleTag({
  content: "[class*=stageWrap] [role=status]{display:none!important}",
});
await page.waitForTimeout(2200);

const set = (weights, expression) =>
  page.evaluate(([w, e]) => window.__YURAGOO_LAB_E2E__.set(w, e), [weights, expression]);

const shots = [
  // padR lets the stretched pose keep its right-edge whisker marks.
  { name: "rest", weights: [25, 25, 25, 25], expr: "rest", padR: 0 },
  { name: "pull", weights: [8, 70, 12, 10], expr: "engaged", padR: 0.35 },
  { name: "stretch", weights: [3, 92, 3, 2], expr: "adhering", padR: 0.55 },
];
for (const s of shots) {
  await set(s.weights, s.expr);
  await page.waitForTimeout(1500);
  const raw = resolve(capDir, `creature-${s.name}-raw.png`);
  const rgb = resolve(capDir, `creature-${s.name}.rgb`);
  await stage.screenshot({ path: raw });
  const b = bodyBox(raw, rgb);
  const side = Math.round(Math.max(b.w, b.h * 1.28) * (1.3 + s.padR));
  const cx = b.x + b.w / 2 + (b.w * s.padR) / 2;
  const cy = b.y + b.h / 2 + b.h * 0.09; // include the shadow below
  const x = Math.max(0, Math.min(b.imgW - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(b.imgH - side, Math.round(cy - side / 2)));
  execSync(
    `ffmpeg -y -i "${raw}" -vf "crop=${side}:${side}:${x}:${y}" "${resolve(capDir, `creature-${s.name}.png`)}"`,
  );
  console.log(`wrote creature-${s.name}.png body=${b.w}x${b.h} crop=${side}@${x},${y}`);
}
await browser.close();
