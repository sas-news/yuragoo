// Shared bits for brand assets. The creature itself is NOT drawn here —
// docs/brand/src/captures/*.png are crops of the real Pixi renderer
// (capture-creature.mjs drives /dev/creature via __YURAGOO_LAB_E2E__), so
// the face, contour and pull-stretch are the actual game rendering.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

// Data-URI embed of a captured creature crop ("rest" | "pull" | "stretch").
export const cap = (name) =>
  `data:image/png;base64,${readFileSync(resolve(dir, "captures", `creature-${name}.png`)).toString("base64")}`;

export const rings = (cx, cy, base, color = "#27a98b") =>
  [1.55, 1.95, 2.4]
    .map(
      (r, i) =>
        `<circle cx="${cx}" cy="${cy}" r="${(r * base).toFixed(0)}" fill="none" stroke="${color}" stroke-width="3" opacity="${0.34 - i * 0.08}"/>`,
    )
    .join("");

// Curved arrow tugging toward a point — the "ひとことで引っ張る" motif.
export const pull = (x1, y1, x2, y2, cx, cy, color) =>
  `<path d="M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2} M${x2} ${y2} l-30 -10 M${x2} ${y2} l-6 30" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`;

export const FONT = `'M PLUS Rounded 1c','BIZ UDPGothic','Hiragino Maru Gothic ProN','Yu Gothic',sans-serif`;

export const FONT_LINK =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@700;800&display=swap">';
