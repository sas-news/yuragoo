// Discord portal asset generator (release polish): emits SVG sources under
// docs/brand/src and rasterizes the PNGs the Developer Portal asks for —
// app icon (opaque bg), grid background overlay (edges decorated, center
// clear), shelf cover art (title + creature). Video preview is produced
// separately by recording the live app.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const brandDir = resolve(dir, "..");

// The creature — same palette and face geometry as packages/creature:
// mint body, deeper-teal underside, two vertical white eyes with ink
// pupils, a small calm arc for a mouth. No limbs, no name, no props.
const creature = (x, y, s, extra = "") => `
  <g transform="translate(${x} ${y}) scale(${s})">
    ${extra}
    <defs>
      <radialGradient id="body${x}${y}" cx="42%" cy="32%" r="80%">
        <stop offset="0%" stop-color="#b2f4e3"/>
        <stop offset="55%" stop-color="#78dfc5"/>
        <stop offset="100%" stop-color="#54c7a8"/>
      </radialGradient>
      <clipPath id="clip${x}${y}">
        <path d="M256 86 C334 78 408 128 430 208 C448 276 426 358 358 402 C298 440 208 442 148 404 C82 362 62 276 84 208 C108 130 178 94 256 86 Z"/>
      </clipPath>
    </defs>
    <ellipse cx="258" cy="452" rx="152" ry="20" fill="#72546a" opacity="0.18"/>
    <path d="M256 86 C334 78 408 128 430 208 C448 276 426 358 358 402 C298 440 208 442 148 404 C82 362 62 276 84 208 C108 130 178 94 256 86 Z" fill="url(#body${x}${y})"/>
    <g clip-path="url(#clip${x}${y})">
      <ellipse cx="256" cy="410" rx="220" ry="90" fill="#27a98b" opacity="0.22"/>
    </g>
    <path d="M256 86 C334 78 408 128 430 208 C448 276 426 358 358 402 C298 440 208 442 148 404 C82 362 62 276 84 208 C108 130 178 94 256 86 Z" fill="none" stroke="#27a98b" stroke-width="5" opacity="0.55"/>
    <ellipse cx="150" cy="168" rx="42" ry="20" fill="#ffffff" opacity="0.35" transform="rotate(-32 150 168)"/>
    <ellipse cx="190" cy="226" rx="31" ry="38" fill="#f4fff9"/>
    <ellipse cx="324" cy="226" rx="31" ry="38" fill="#f4fff9"/>
    <circle cx="194" cy="230" r="14" fill="#402f3b"/>
    <circle cx="328" cy="230" r="14" fill="#402f3b"/>
    <circle cx="200" cy="222" r="5" fill="#ffffff"/>
    <circle cx="334" cy="222" r="5" fill="#ffffff"/>
    <path d="M232 314 Q256 334 280 314" stroke="#402f3b" stroke-width="11" stroke-linecap="round" fill="none"/>
  </g>`;

const rings = (cx, cy, base, color = "#27a98b") =>
  [1.55, 1.95, 2.4]
    .map(
      (r, i) =>
        `<circle cx="${cx}" cy="${cy}" r="${(r * base).toFixed(0)}" fill="none" stroke="${color}" stroke-width="3" opacity="${0.34 - i * 0.08}"/>`,
    )
    .join("");

const FONT = `'M PLUS Rounded 1c','BIZ UDPGothic','Hiragino Maru Gothic ProN','Yu Gothic',sans-serif`;

const svgs = {
  // Developer Portal → App Icon (opaque paper bg — Discord shows it square).
  "discord-icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="ゆらぐー！">
    <title>ゆらぐー！ アプリアイコン</title>
    <rect width="512" height="512" fill="#fff7e8"/>
    ${rings(256, 262, 96)}
    ${creature(20, 52, 0.92)}
  </svg>`,

  // Activity → 背景 (grid overlay): artwork hugging the edges, the center
  // kept clear so the Discord UI grid never fights the art.
  "background.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 576" role="img" aria-label="ゆらぐー！ 背景">
    <title>ゆらぐー！ グリッド背景</title>
    <rect width="1024" height="576" fill="#fff7e8"/>
    ${rings(60, 300, 90)} ${rings(964, 300, 90)}
    ${rings(512, 596, 70)}
    ${creature(-210, 118, 0.78)}
    ${creature(864, 118, 0.78)}
    ${creature(372, 452, 0.42)}
    <g fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M240 96 C330 140 368 170 400 208 M400 208 l-34 -6 M400 208 l-2 34" stroke="#e0709a"/>
      <path d="M784 96 C694 140 656 170 624 208 M624 208 l34 -6 M624 208 l2 34" stroke="#5f7fdb"/>
      <path d="M512 540 C512 480 512 440 512 420 M512 420 l-18 30 M512 420 l18 30" stroke="#f0a03c"/>
    </g>
  </svg>`,

  // Activity → カバーアート (shelf main image): title + creature, 16:9.
  "cover.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 576" role="img" aria-label="ゆらぐー！ カバーアート">
    <title>ゆらぐー！ カバーアート</title>
    <rect width="1024" height="576" fill="#fff7e8"/>
    ${rings(742, 268, 118)}
    ${creature(570, 66, 0.78)}
    <g fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M470 120 C520 150 552 172 580 198 M580 198 l-32 -8 M580 198 l-6 32" stroke="#e0709a"/>
      <path d="M470 268 C518 268 546 268 572 266 M572 266 l-26 -16 M572 266 l-24 18" stroke="#f0a03c"/>
      <path d="M470 416 C520 386 552 362 578 336 M578 336 l-30 8 M578 336 l-10 -30" stroke="#5f7fdb"/>
    </g>
    <g font-family="${FONT}">
      <text x="72" y="268" font-size="104" font-weight="800" fill="#402f3b">ゆらぐー！</text>
      <text x="76" y="332" font-size="28" font-weight="700" fill="#715e6b">なまえのない生命体を、みんなのひとことで</text>
      <text x="76" y="374" font-size="28" font-weight="700" fill="#715e6b">引っ張るパーティーゲーム</text>
      <text x="76" y="444" font-size="22" font-weight="700" fill="#27a98b">2〜6人であそべるよ</text>
    </g>
    <circle cx="60" cy="438" r="8" fill="#e0709a" stroke="#402f3b" stroke-width="2"/>
  </svg>`,
};

const jobs = [
  { src: "discord-icon.svg", out: "discord-icon-512.png", w: 512, h: 512 },
  { src: "background.svg", out: "background-1024x576.png", w: 1024, h: 576 },
  { src: "cover.svg", out: "cover-1024x576.png", w: 1024, h: 576 },
];

const browser = await chromium.launch();
for (const j of jobs) {
  const svg = svgs[j.src];
  writeFileSync(resolve(dir, j.src), svg);
  const page = await browser.newPage({ viewport: { width: j.w, height: j.h } });
  await page.setContent(
    `<body style="margin:0">${svg.replace("<svg ", `<svg width="${j.w}" height="${j.h}" `)}</body>`,
  );
  await page.screenshot({ path: resolve(brandDir, j.out) });
  await page.close();
  console.log("wrote", j.out);
}
await browser.close();
