// Shared creature markup for brand assets — same palette and face geometry
// as packages/creature. opts.stretch elongates the body (the pulled pose):
// eyes stay round but drift wider apart, and a stretched creature gets the
// small "adhering" oval mouth instead of the resting smile.

export const BODY_PATH =
  "M256 86 C334 78 408 128 430 208 C448 276 426 358 358 402 C298 440 208 442 148 404 C82 362 62 276 84 208 C108 130 178 94 256 86 Z";

export const creature = (uid, x, y, s, { sx = 1, sy = 1 } = {}) => {
  const cx = 256;
  const cy = 264;
  const pull = `translate(${cx} ${cy}) scale(${sx} ${sy}) translate(-${cx} -${cy})`;
  const eyeL = 190 - (sx - 1) * 60;
  const eyeR = 324 + (sx - 1) * 60;
  const mouthY = 314 + (sy - 1) * -30;
  const mouth =
    sx > 1.08
      ? `<ellipse cx="256" cy="${mouthY + 8}" rx="14" ry="18" fill="none" stroke="#402f3b" stroke-width="10"/>`
      : `<path d="M232 ${mouthY} Q256 ${mouthY + 20} 280 ${mouthY}" stroke="#402f3b" stroke-width="11" stroke-linecap="round" fill="none"/>`;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <defs>
      <radialGradient id="body${uid}" cx="42%" cy="32%" r="80%">
        <stop offset="0%" stop-color="#b2f4e3"/>
        <stop offset="55%" stop-color="#78dfc5"/>
        <stop offset="100%" stop-color="#4cba9c"/>
      </radialGradient>
      <clipPath id="clip${uid}"><path d="${BODY_PATH}" transform="${pull}"/></clipPath>
    </defs>
    <ellipse cx="258" cy="452" rx="${152 * Math.max(1, sx)}" ry="20" fill="#72546a" opacity="0.2"/>
    <g transform="${pull}">
      <path d="${BODY_PATH}" fill="url(#body${uid})"/>
    </g>
    <g clip-path="url(#clip${uid})">
      <ellipse cx="256" cy="410" rx="220" ry="90" fill="#27a98b" opacity="0.3"/>
    </g>
    <path d="${BODY_PATH}" transform="${pull}" fill="none" stroke="#1f8f74" stroke-width="7" opacity="0.75"/>
    <ellipse cx="150" cy="168" rx="42" ry="20" fill="#ffffff" opacity="0.35" transform="rotate(-32 150 168)"/>
    <ellipse cx="${eyeL}" cy="226" rx="31" ry="38" fill="#f4fff9"/>
    <ellipse cx="${eyeR}" cy="226" rx="31" ry="38" fill="#f4fff9"/>
    <circle cx="${eyeL - 8}" cy="230" r="14" fill="#402f3b"/>
    <circle cx="${eyeR - 8}" cy="230" r="14" fill="#402f3b"/>
    <circle cx="${eyeL - 2}" cy="222" r="5" fill="#ffffff"/>
    <circle cx="${eyeR - 2}" cy="222" r="5" fill="#ffffff"/>
    ${mouth}
  </g>`;
};

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
