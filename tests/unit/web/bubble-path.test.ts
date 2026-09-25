// Task 13e: pure bubble-geometry invariants — inward seat anchoring (the
// bubble sits between its chip and the creature), arena clamping
// (tangential slide, no seat special cases), tail spikes that stop short
// of the chip, and a well-formed chamfered path. Coordinates mirror
// BubbleLayer: anchor/tail math in layer px, tailFor inputs are box-local.
import { describe, expect, test } from "bun:test";
import {
  bubbleAnchor,
  boxAt,
  chamferedBubblePath,
  growRect,
  outwardFrom,
  spikePath,
  tailFor,
} from "../../../apps/web/src/game/bubblePath";
import type { Pt, Rect } from "../../../apps/web/src/game/bubblePath";
import { CHIP_SIZE } from "../../../apps/web/src/game/seats";

const ARENA = { w: 1000, h: 500 };
const CENTER: Pt = { x: 500, y: 250 };
const BUBBLE = { w: 200, h: 60 };
const MARGIN = 10;

// A four-seat ring like /dev/game: top / right / bottom / left.
const SEATS = {
  top: { x: 500, y: 38 },
  right: { x: 920, y: 250 },
  bottom: { x: 500, y: 440 },
  left: { x: 80, y: 250 },
} satisfies Record<string, Pt>;

const chipRect = (seat: Pt): Rect => boxAt(seat, CHIP_SIZE);
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const place = (seat: Pt, others: readonly Pt[] = []): Rect => {
  const c = bubbleAnchor(seat, CENTER, BUBBLE, CHIP_SIZE, ARENA, others.map(chipRect));
  return boxAt(c, BUBBLE);
};

// Same box-local conversion BubbleView performs before calling tailFor.
const tail = (seat: Pt, box: Rect) =>
  tailFor(
    { x: seat.x - box.x, y: seat.y - box.y },
    BUBBLE,
    growRect(boxAt({ x: seat.x - box.x, y: seat.y - box.y }, CHIP_SIZE), 0),
  );

describe("bubbleAnchor", () => {
  test("bubble hugs the chip's INWARD side — between chip and creature", () => {
    // The bubble center must sit closer to the arena center than its seat
    // (inward of the chip) and never cover the chip itself.
    for (const [name, seat] of Object.entries(SEATS)) {
      const b = place(seat);
      const chip = chipRect(seat);
      const dSeat = Math.hypot(seat.x - CENTER.x, seat.y - CENTER.y);
      const dBub = Math.hypot(b.x + BUBBLE.w / 2 - CENTER.x, b.y + BUBBLE.h / 2 - CENTER.y);
      expect(dBub, name).toBeLessThan(dSeat);
      expect(overlap(b, chip), name).toBe(false);
    }
  });

  test("box stays inside the arena margin and clears its own chip", () => {
    const others = Object.values(SEATS);
    for (const [name, seat] of Object.entries(SEATS)) {
      const b = place(
        seat,
        others.filter((o) => o !== seat),
      );
      expect(b.x, name).toBeGreaterThanOrEqual(MARGIN - 0.5);
      expect(b.y, name).toBeGreaterThanOrEqual(MARGIN - 0.5);
      expect(b.x + b.w, name).toBeLessThanOrEqual(ARENA.w - MARGIN + 0.5);
      expect(b.y + b.h, name).toBeLessThanOrEqual(ARENA.h - MARGIN + 0.5);
      expect(overlap(b, chipRect(seat)), name).toBe(false);
    }
  });

  test("a blocker on the inward lane slides the bubble tangentially", () => {
    // A chip-shaped blocker parked where the bottom bubble would land.
    const blocker: Rect = { x: 360, y: 300, w: 280, h: 120 };
    const naive = boxAt({ x: 500, y: 356 }, BUBBLE);
    expect(overlap(naive, blocker)).toBe(true);
    const b = place(SEATS.bottom, []);
    const c = bubbleAnchor(SEATS.bottom, CENTER, BUBBLE, CHIP_SIZE, ARENA, [blocker]);
    const moved = boxAt(c, BUBBLE);
    expect(moved.w).toBe(BUBBLE.w);
    expect(overlap(moved, blocker)).toBe(false);
    expect(overlap(moved, chipRect(SEATS.bottom))).toBe(false);
    expect(moved.x).toBeGreaterThanOrEqual(MARGIN - 0.5);
    expect(moved.x + moved.w).toBeLessThanOrEqual(ARENA.w - MARGIN + 0.5);
    expect(b.x + b.w / 2).toBeCloseTo(500, 0);
  });
});

describe("tailFor", () => {
  test("spike sits on the seat-facing edge and stops short of the chip", () => {
    const box = place(SEATS.bottom);
    const t = tail(SEATS.bottom, box);
    expect(t).not.toBeNull();
    if (t === null) return;
    // The bottom seat's bubble sits above its chip -> spike exits the
    // bottom edge, protruding down toward the seat.
    expect(t.edge).toBe("bottom");
    expect(t.tip.y).toBeGreaterThan(BUBBLE.h);
    // The tip never reaches the chip's rim (keeps ~6px clearance).
    const chip = boxAt({ x: SEATS.bottom.x - box.x, y: SEATS.bottom.y - box.y }, CHIP_SIZE);
    expect(t.tip.y).toBeLessThan(chip.y);
  });

  test("tip direction matches the seat direction within 20 degrees", () => {
    for (const [name, seat] of Object.entries(SEATS)) {
      const box = place(seat);
      const t = tail(seat, box);
      expect(t, name).not.toBeNull();
      if (t === null) continue;
      const want =
        (Math.atan2(seat.y - (box.y + BUBBLE.h / 2), seat.x - (box.x + BUBBLE.w / 2)) * 180) /
        Math.PI;
      const diff = Math.abs(((t.deg - want + 540) % 360) - 180);
      expect(Math.abs(t.deg - want) < 20 || diff < 20, name).toBe(true);
    }
  });
});

describe("chamferedBubblePath", () => {
  test("emits a closed path that includes the tail tip", () => {
    const box = place(SEATS.top);
    const t = tail(SEATS.top, box);
    expect(t).not.toBeNull();
    if (t === null) return;
    const d = chamferedBubblePath(BUBBLE.w, BUBBLE.h, 14, t);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain(`${Math.round(t.tip.x * 10) / 10}`);
  });

  test("plain frame is a centered octagon", () => {
    const d = chamferedBubblePath(BUBBLE.w, BUBBLE.h, 14, null);
    const pts = d
      .slice(1, -1)
      .split("L")
      .map((p) => p.trim().split(" ").map(Number));
    expect(pts.length).toBe(8);
    const cx = pts.reduce((s, p) => s + (p[0] ?? 0), 0) / 8;
    const cy = pts.reduce((s, p) => s + (p[1] ?? 0), 0) / 8;
    expect(cx).toBeCloseTo(BUBBLE.w / 2, 4);
    expect(cy).toBeCloseTo(BUBBLE.h / 2, 4);
  });

  test("spike path is a triangle reaching the tip", () => {
    const box = place(SEATS.left);
    const t = tail(SEATS.left, box);
    expect(t).not.toBeNull();
    if (t === null) return;
    const d = spikePath(t, BUBBLE);
    expect(d).toContain(`${Math.round(t.tip.x * 10) / 10}`);
    expect(d.split("L").length - 1).toBe(2);
  });
});

describe("outwardFrom", () => {
  test("normalizes the radial direction; falls back to up at the center", () => {
    expect(outwardFrom({ x: 800, y: 250 }, CENTER).x).toBeGreaterThan(0);
    const zero = outwardFrom(CENTER, CENTER);
    expect(zero.x).toBe(0);
    expect(zero.y).toBe(-1);
  });
});
