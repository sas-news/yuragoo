// Attractor-anchored seat geometry. A player's seat IS the attractor marker
// the creature pulls toward — 真ん中の生命体が引っ張られる先 — so the chip is
// planted on that post: ~48px outward along the radial direction, then
// clamped so the whole chip stays inside the arena and clear of the dock.
// Positions are px relative to the arena box (the stage canvas fills it, so
// canvas px == arena px).
import { useCallback, useEffect, useState } from "react";
import type { CreatureRuntime } from "@yuragoo/creature";

export interface SeatPoint {
  readonly x: number;
  readonly y: number;
}

export interface ArenaSize {
  readonly w: number;
  readonly h: number;
}

export type SeatMap = Readonly<Record<string, SeatPoint>>;

// The anchored point is the AVATAR's center — the icon sits exactly on the
// attractor post (Discord-style: icon at the seat, name centered under it).
const OUTWARD_PX = 0;
// The chip (turn wedge + 64px icon + name pill + goal) measures up to
// ~112x160px around the anchor. CHIP_SIZE doubles as the bubble layer's
// clearance rect (bubbles hug the chip's inner side without touching it).
const EDGE_PX = 10;
const HALF_CHIP_X = 56;
const HALF_CHIP_Y = 80;
export const CHIP_SIZE = { w: HALF_CHIP_X * 2, h: HALF_CHIP_Y * 2 } as const;

// Narrow arenas get a taller top margin so the top seat never lands under
// the HUD/scenario strip (the strip lives at top-left ~y54-83).
const NARROW_W = 640;
const NARROW_TOP_PX = 92;
// PIP-tier arenas (Discord's pop-out, ~<=460px wide OR ~<=480px tall):
// chips shrink to a 40px icon + a slimmer name pill — keep this aligned
// with the matching @media tier in PlayerSeats.module.css.
const TINY_W = 460;
const TINY_H = 480;
const TINY_TOP_PX = 64;
const HALF_ICON_X_TINY = 20;
const HALF_CHIP_Y_TINY = 56;

// The horizontal clamp keeps only the ICON onscreen (64px wide / 48px on
// narrow arenas) — never the whole chip. A wider clamp drags edge seats
// visibly off their attractor posts toward the center (円とずれる); the
// name pill may clip a few px at the edge instead, which reads better
// than a seat floating off its post.
const HALF_ICON_X = 32;
const HALF_ICON_X_NARROW = 24;

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(value, lo), Math.max(lo, hi));

export const seatAnchor = (
  attractor: SeatPoint,
  center: SeatPoint,
  arena: ArenaSize,
): SeatPoint => {
  const dx = attractor.x - center.x;
  const dy = attractor.y - center.y;
  const len = Math.hypot(dx, dy);
  // Degenerate case (marker at the exact center): push the chip upward.
  const ux = len > 0.001 ? dx / len : 0;
  const uy = len > 0.001 ? dy / len : -1;
  const tiny = arena.w < TINY_W || arena.h < TINY_H;
  const topEdge = tiny ? TINY_TOP_PX : arena.w < NARROW_W ? NARROW_TOP_PX : EDGE_PX;
  const halfX = tiny ? HALF_ICON_X_TINY : arena.w < NARROW_W ? HALF_ICON_X_NARROW : HALF_ICON_X;
  const halfChipY = tiny ? HALF_CHIP_Y_TINY : HALF_CHIP_Y;
  return {
    x: clamp(attractor.x + ux * OUTWARD_PX, halfX, arena.w - halfX),
    y: clamp(attractor.y + uy * OUTWARD_PX, topEdge + halfChipY, arena.h - EDGE_PX - halfChipY),
  };
};

// Roster slot i rides attractor i: the presentation's attraction samples are
// built in canonical slot order, so attractorCenters[player.slot] is that
// player's post.
export const seatAnchors = (
  roster: readonly { readonly id: string; readonly slot: number }[],
  attractors: readonly SeatPoint[],
  arena: ArenaSize,
): SeatMap => {
  const center = { x: arena.w / 2, y: arena.h / 2 };
  const map: Record<string, SeatPoint> = {};
  for (const player of roster) {
    const attractor = attractors[player.slot];
    if (attractor !== undefined) map[player.id] = seatAnchor(attractor, center, arena);
  }
  return map;
};

// Live seat anchors for the stage: reads the creature runtime's layout
// summary once it is ready, then re-computes whenever the arena box resizes
// (a second pass on rAF catches Pixi's own relayout, which lands a frame
// after the DOM resize).
export const useSeatAnchors = (
  roster: readonly { readonly id: string; readonly slot: number }[],
  runtime: CreatureRuntime | null,
  arenaRef: { readonly current: HTMLElement | null },
): SeatMap => {
  const [anchors, setAnchors] = useState<SeatMap>({});

  const recompute = useCallback((): void => {
    const arena = arenaRef.current;
    if (arena === null || runtime === null) return;
    const rect = arena.getBoundingClientRect();
    setAnchors(
      seatAnchors(roster, runtime.readLayoutSummary().attractorCenters, {
        w: rect.width,
        h: rect.height,
      }),
    );
  }, [arenaRef, runtime, roster]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const arena = arenaRef.current;
    if (arena === null) return;
    const observer = new ResizeObserver(() => {
      recompute();
      requestAnimationFrame(recompute);
    });
    observer.observe(arena);
    return () => observer.disconnect();
  }, [recompute, arenaRef]);

  return anchors;
};
