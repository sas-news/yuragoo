// Brand asset generator: single source for the creature mark, emitting SVG
// sources + rasterized PNGs for BOTH the web bundle (apps/web/public) and
// the Discord Developer Portal (docs/brand). The creature is drawn STRETCHED
// — pulled taut by the players' words — which is the game's signature pose.
//
// Fonts: the rasterizer loads M PLUS Rounded 1c (the app's display face)
// from Google Fonts and waits on document.fonts.ready, so titles render in
// the real typeface rather than a system fallback.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { creature, FONT, FONT_LINK, pull, rings } from "./creature.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const brandDir = resolve(dir, "..");
const publicDir = resolve(dir, "../../../apps/web/public");

const svgs = {
  // favicon + PNG derivations — a gentle squash, round face still legible
  // at 16px.
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="ゆらぐー！">
    <title>ゆらぐー！</title>
    ${creature("i", 36, 72, 0.86, { sx: 1.16, sy: 0.9 })}
  </svg>`,

  // OGP / social card — creature pulled hard toward the incoming arrows.
  og: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="ゆらぐー！ — なまえのない生命体を、みんなのひとことで引っ張るパーティーゲーム">
    <title>ゆらぐー！</title>
    <rect width="1200" height="630" fill="#fff7e8"/>
    ${rings(852, 320, 108)}
    ${creature("og", 668, 126, 0.95, { sx: 1.42, sy: 0.8 })}
    ${pull(596, 132, 668, 206, 640, 150, "#e0709a")}
    ${pull(596, 320, 664, 318, 630, 322, "#f0a03c")}
    ${pull(596, 500, 670, 416, 636, 470, "#5f7fdb")}
    <g font-family="${FONT}">
      <text x="92" y="240" font-size="124" font-weight="800" fill="#402f3b">ゆらぐー！</text>
      <text x="96" y="322" font-size="33" font-weight="700" fill="#715e6b">なまえのない生命体を、</text>
      <text x="96" y="374" font-size="33" font-weight="700" fill="#715e6b">みんなのひとことで引っ張るパーティーゲーム。</text>
      <text x="96" y="468" font-size="25" font-weight="700" fill="#1f8f74">2〜6人であそべるよ</text>
    </g>
    <circle cx="82" cy="462" r="9" fill="#e0709a" stroke="#402f3b" stroke-width="2"/>
  </svg>`,

  // Developer Portal → App Icon (opaque paper bg — Discord shows it square).
  "discord-icon": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="ゆらぐー！">
    <title>ゆらぐー！ アプリアイコン</title>
    <rect width="512" height="512" fill="#fff7e8"/>
    ${rings(256, 262, 96)}
    ${creature("di", 30, 58, 0.88, { sx: 1.2, sy: 0.88 })}
  </svg>`,

  // Activity → 背景 (grid overlay): art at the edges, center kept clear.
  background: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 576" role="img" aria-label="ゆらぐー！ 背景">
    <title>ゆらぐー！ グリッド背景</title>
    <rect width="1024" height="576" fill="#fff7e8"/>
    ${rings(60, 300, 90)} ${rings(964, 300, 90)} ${rings(512, 600, 66)}
    ${creature("bl", -230, 130, 0.8, { sx: 1.3, sy: 0.84 })}
    ${creature("br", 950, 130, 0.8, { sx: 1.3, sy: 0.84 })}
    ${creature("bb", 382, 466, 0.4, { sx: 1.15, sy: 0.9 })}
    ${pull(250, 90, 330, 190, 300, 120, "#e0709a")}
    ${pull(774, 90, 694, 190, 724, 120, "#5f7fdb")}
    ${pull(512, 556, 512, 470, 512, 520, "#f0a03c")}
  </svg>`,

  // Activity → カバーアート (shelf main): big title + stretched creature.
  cover: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 576" role="img" aria-label="ゆらぐー！ カバーアート">
    <title>ゆらぐー！ カバーアート</title>
    <rect width="1024" height="576" fill="#fff7e8"/>
    ${rings(768, 270, 112)}
    ${creature("cv", 596, 76, 0.78, { sx: 1.38, sy: 0.8 })}
    ${pull(452, 118, 560, 190, 500, 140, "#e0709a")}
    ${pull(452, 268, 556, 268, 510, 268, "#f0a03c")}
    ${pull(452, 424, 562, 350, 502, 400, "#5f7fdb")}
    <g font-family="${FONT}">
      <text x="68" y="252" font-size="110" font-weight="800" fill="#402f3b">ゆらぐー！</text>
      <text x="72" y="326" font-size="27" font-weight="700" fill="#715e6b">なまえのない生命体を、みんなのひとことで</text>
      <text x="72" y="366" font-size="27" font-weight="700" fill="#715e6b">引っ張るパーティーゲーム</text>
      <text x="72" y="440" font-size="21" font-weight="700" fill="#1f8f74">2〜6人であそべるよ</text>
    </g>
    <circle cx="56" cy="434" r="8" fill="#e0709a" stroke="#402f3b" stroke-width="2"/>
  </svg>`,
};

const jobs = [
  { key: "icon", dir: publicDir, svg: "icon.svg", out: "icon-512.png", w: 512, h: 512, bg: null },
  {
    key: "icon",
    dir: publicDir,
    svg: null,
    out: "apple-touch-icon.png",
    w: 180,
    h: 180,
    bg: "#fff7e8",
  },
  { key: "og", dir: publicDir, svg: "og.svg", out: "og.png", w: 1200, h: 630, bg: "#fff7e8" },
  {
    key: "discord-icon",
    dir: brandDir,
    svg: "src/discord-icon.svg",
    out: "discord-icon-512.png",
    w: 512,
    h: 512,
    bg: "#fff7e8",
  },
  {
    key: "background",
    dir: brandDir,
    svg: "src/background.svg",
    out: "background-1024x576.png",
    w: 1024,
    h: 576,
    bg: "#fff7e8",
  },
  {
    key: "cover",
    dir: brandDir,
    svg: "src/cover.svg",
    out: "cover-1024x576.png",
    w: 1024,
    h: 576,
    bg: "#fff7e8",
  },
];

const browser = await chromium.launch();
for (const j of jobs) {
  const svg = svgs[j.key];
  if (j.svg) writeFileSync(resolve(j.dir, j.svg), svg);
  const page = await browser.newPage({ viewport: { width: j.w, height: j.h } });
  await page.setContent(
    `${FONT_LINK}<body style="margin:0;background:${j.bg ?? "transparent"}">${svg.replace("<svg ", `<svg width="${j.w}" height="${j.h}" `)}</body>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(j.dir, j.out), omitBackground: j.bg === null });
  await page.close();
  console.log("wrote", j.out);
}
await browser.close();
