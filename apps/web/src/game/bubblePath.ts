// Pure speech-bubble geometry: bubbles anchor on the INWARD side of the
// seat chip — between the chip and the creature, never covering the seat.
// `bubbleAnchor` pushes the bubble center radially inward past the chip
// rim, clamps the box inside the arena, and slides tangentially around
// blockers. `tailFor` aims the rim spike at the chip but stops short.
// `chamferedBubblePath` emits rect+spike as one path -> uniform outline.

export interface Pt {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly w: number;
  readonly h: number;
}
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export type Edge = "top" | "right" | "bottom" | "left";

export const BUBBLE_CUT = 14;
export const TAIL_DEPTH = 20;
export const TAIL_SPREAD = 16;
// Clearance between the chip's rim and the bubble's seat-facing rim — the
// tail spike spans most of it.
export const SEAT_GAP = 26;
export const ARENA_MARGIN = 10;
const TAIL_CLEARANCE = 6; // the spike tip stops this far short of the chip
const EPS = 0.001;

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

// Distance from a (2hx x 2hy) box center to its rim along unit (ux, uy).
export const rim = (hx: number, hy: number, ux: number, uy: number): number =>
  Math.min(
    Math.abs(ux) > EPS ? hx / Math.abs(ux) : Number.POSITIVE_INFINITY,
    Math.abs(uy) > EPS ? hy / Math.abs(uy) : Number.POSITIVE_INFINITY,
  );

// Unit vector arena-center -> seat (the outward radial). Fallback: up.
export const outwardFrom = (seat: Pt, center: Pt): Pt => {
  const len = Math.hypot(seat.x - center.x, seat.y - center.y);
  return len > EPS
    ? { x: (seat.x - center.x) / len, y: (seat.y - center.y) / len }
    : { x: 0, y: -1 };
};

export const boxAt = (c: Pt, s: Size): Rect => ({
  x: c.x - s.w / 2,
  y: c.y - s.h / 2,
  w: s.w,
  h: s.h,
});
export const growRect = (r: Rect, m: number): Rect => ({
  x: r.x - m,
  y: r.y - m,
  w: r.w + 2 * m,
  h: r.h + 2 * m,
});

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Center for a bubble hugging the INWARD side of its chip — between the
// seat and the creature. `obstacles` are the other chips' boxes (layer px)
// the bubble must also clear.
export const bubbleAnchor = (
  seat: Pt,
  center: Pt,
  bubble: Size,
  chip: Size,
  arena: Size,
  obstacles: readonly Rect[] = [],
): Pt => {
  const u = outwardFrom(seat, center);
  const hx = bubble.w / 2;
  const hy = bubble.h / 2;
  const reach = rim(chip.w / 2, chip.h / 2, u.x, u.y) + SEAT_GAP + rim(hx, hy, u.x, u.y);
  const cx0 = clamp(seat.x - u.x * reach, hx + ARENA_MARGIN, arena.w - hx - ARENA_MARGIN);
  const cy0 = clamp(seat.y - u.y * reach, hy + ARENA_MARGIN, arena.h - hy - ARENA_MARGIN);
  // The own chip grown by ~3/4 of the gap so the tail keeps breathing room;
  // other chips only need a small clearance.
  const blockers = [
    growRect(boxAt(seat, chip), SEAT_GAP * 0.75),
    ...obstacles.map((o) => growRect(o, 6)),
  ];
  const clear = (c: Pt): boolean => blockers.every((b) => !overlaps(boxAt(c, bubble), b));
  if (clear({ x: cx0, y: cy0 })) return { x: cx0, y: cy0 };

  // Slide along the tangent (perpendicular to the dominant radial axis) to
  // the nearest flush position that clears every blocker.
  const flush = (axis: "x" | "y"): number[] => {
    const out: number[] = [];
    for (const b of blockers) {
      if (axis === "x" && cy0 + hy > b.y && cy0 - hy < b.y + b.h)
        out.push(b.x - hx, b.x + b.w + hx);
      if (axis === "y" && cx0 + hx > b.x && cx0 - hx < b.x + b.w)
        out.push(b.y - hy, b.y + b.h + hy);
    }
    return out;
  };
  const pick = (axis: "x" | "y", dir: number): number | null => {
    const lo = (axis === "x" ? hx : hy) + ARENA_MARGIN;
    const hi = (axis === "x" ? arena.w - hx : arena.h - hy) - ARENA_MARGIN;
    const from = axis === "x" ? cx0 : cy0;
    const cands = flush(axis)
      .map((v) => clamp(v, lo, hi))
      .filter((v) => clear(axis === "x" ? { x: v, y: cy0 } : { x: cx0, y: v }));
    cands.sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || (dir >= 0 ? b - a : a - b));
    return cands[0] ?? null;
  };

  const axis = Math.abs(u.x) >= Math.abs(u.y) ? "y" : "x";
  const first = pick(axis, axis === "x" ? u.x : u.y);
  if (first !== null) return axis === "x" ? { x: first, y: cy0 } : { x: cx0, y: first };
  const other = pick(axis === "x" ? "y" : "x", axis === "x" ? u.y : u.x);
  return other === null
    ? { x: cx0, y: cy0 }
    : axis === "x"
      ? { x: cx0, y: other }
      : { x: other, y: cy0 };
};

export interface Tail {
  readonly edge: Edge;
  readonly at: number; // coordinate along the edge, box-local px
  readonly spread: number; // spike base half-width (shrinks on short edges)
  readonly tip: Pt; // spike tip, box-local px — aimed at the chip
  readonly deg: number; // base -> tip direction, screen deg (0 = +x)
}

// Ray-vs-rect entry distance (slab test); Infinity when the ray misses.
const rayRect = (o: Pt, d: Pt, r: Rect): number => {
  const slab = (p: number, v: number, lo: number, hi: number): readonly [number, number] => {
    if (Math.abs(v) < 1e-9)
      return p >= lo && p <= hi ? [-Infinity, Infinity] : [Infinity, -Infinity];
    const t0 = (lo - p) / v;
    const t1 = (hi - p) / v;
    return t0 <= t1 ? [t0, t1] : [t1, t0];
  };
  const [a0, a1] = slab(o.x, d.x, r.x, r.x + r.w);
  const [b0, b1] = slab(o.y, d.y, r.y, r.y + r.h);
  const t0 = Math.max(a0, b0);
  const t1 = Math.min(a1, b1);
  return t1 >= Math.max(0, t0) ? Math.max(0, t0) : Number.POSITIVE_INFINITY;
};

// Tail spike on the rim edge the seat ray exits through — the point nearest
// the seat. All inputs are bubble-box local (origin = box top-left).
export const tailFor = (seat: Pt, size: Size, chip: Rect, cut = BUBBLE_CUT): Tail | null => {
  const hx = size.w / 2;
  const hy = size.h / 2;
  const len = Math.hypot(seat.x - hx, seat.y - hy);
  if (len < EPS) return null;
  const ux = (seat.x - hx) / len;
  const uy = (seat.y - hy) / len;
  const tx = Math.abs(ux) > EPS ? hx / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(uy) > EPS ? hy / Math.abs(uy) : Number.POSITIVE_INFINITY;
  const edge: Edge = tx <= ty ? (ux >= 0 ? "right" : "left") : uy >= 0 ? "bottom" : "top";
  const t = Math.min(tx, ty);
  // The base must fit the edge's straight run — shrink the spread on short
  // edges (a one-line bubble is only ~56px tall).
  const along = edge === "left" || edge === "right" ? size.h : size.w;
  const spread = Math.max(4, Math.min(TAIL_SPREAD, (along - 2 * cut) / 2 - 1));
  const lo = cut + spread;
  const at =
    edge === "left" || edge === "right"
      ? clamp(hy + uy * t, lo, Math.max(lo, size.h - lo))
      : clamp(hx + ux * t, lo, Math.max(lo, size.w - lo));
  const base: Pt =
    edge === "top" || edge === "bottom"
      ? { x: at, y: edge === "top" ? 0 : size.h }
      : { x: edge === "left" ? 0 : size.w, y: at };
  const bx = seat.x - base.x;
  const by = seat.y - base.y;
  const blen = Math.hypot(bx, by) || 1;
  const hit = rayRect(base, { x: bx / blen, y: by / blen }, chip);
  const depth = clamp(
    (Number.isFinite(hit) ? hit : TAIL_DEPTH + TAIL_CLEARANCE) - TAIL_CLEARANCE,
    4,
    TAIL_DEPTH,
  );
  return {
    edge,
    at,
    spread,
    tip: { x: base.x + (bx / blen) * depth, y: base.y + (by / blen) * depth },
    deg: (Math.atan2(by, bx) * 180) / Math.PI,
  };
};

const r1 = (v: number): string => `${Math.round(v * 10) / 10}`;

// Chamfered rectangle + tail spike as ONE closed path: stroke it once and
// every edge — corners and tail union alike — gets the same outline width.
export const chamferedBubblePath = (
  w: number,
  h: number,
  cut = BUBBLE_CUT,
  tail?: Tail | null,
): string => {
  const out: string[] = [`${r1(cut)} 0`];
  const pt = (x: number, y: number): void => {
    out.push(`${r1(x)} ${r1(y)}`);
  };
  // Spike base points follow the clockwise traversal direction (bottom and
  // left run backwards) so the path never folds over itself.
  const seg = (edge: Edge, toX: number, toY: number): void => {
    if (tail?.edge === edge) {
      const dir = edge === "top" || edge === "right" ? 1 : -1;
      const c1 = tail.at - dir * tail.spread;
      const c2 = tail.at + dir * tail.spread;
      const horiz = edge === "top" || edge === "bottom";
      if (horiz) pt(c1, edge === "top" ? 0 : h);
      else pt(edge === "left" ? 0 : w, c1);
      pt(tail.tip.x, tail.tip.y);
      if (horiz) pt(c2, edge === "top" ? 0 : h);
      else pt(edge === "left" ? 0 : w, c2);
    }
    pt(toX, toY);
  };
  seg("top", w - cut, 0);
  pt(w, cut);
  seg("right", w, h - cut);
  pt(w - cut, h);
  seg("bottom", cut, h);
  pt(0, h - cut);
  seg("left", 0, cut);
  return `M${out.join(" L")} Z`;
};

// The slot-colored fill for just the spike — a triangle drawn under the
// union stroke so the tail keeps the same teal rim as the body.
export const spikePath = (tail: Tail, size: Size): string => {
  const horiz = tail.edge === "top" || tail.edge === "bottom";
  const edgeY = tail.edge === "top" ? 0 : size.h;
  const edgeX = tail.edge === "left" ? 0 : size.w;
  const b1 = horiz
    ? `${r1(tail.at - tail.spread)} ${r1(edgeY)}`
    : `${r1(edgeX)} ${r1(tail.at - tail.spread)}`;
  const b2 = horiz
    ? `${r1(tail.at + tail.spread)} ${r1(edgeY)}`
    : `${r1(edgeX)} ${r1(tail.at + tail.spread)}`;
  return `M${b1} L${r1(tail.tip.x)} ${r1(tail.tip.y)} L${b2} Z`;
};
