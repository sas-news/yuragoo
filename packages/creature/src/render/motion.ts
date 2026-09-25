// Mutable second-order damped springs that smooth rendered positions toward
// logical targets without teleporting on presentation changes. Integration
// uses bounded fixed substeps so large frame gaps stay finite and stable.
const FIXED_STEP = 1 / 240;
const MAX_DT = 0.1;

export interface MotionState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly stiffness: number;
  readonly damping: number;
}

export const createMotionState = (
  x: number,
  y: number,
  stiffness: number,
  damping: number,
): MotionState => ({ x, y, vx: 0, vy: 0, stiffness, damping });

export const advanceMotion = (
  state: MotionState,
  targetX: number,
  targetY: number,
  dtSeconds: number,
  reducedMotion: boolean,
): void => {
  if (reducedMotion) {
    state.x = targetX;
    state.y = targetY;
    state.vx = 0;
    state.vy = 0;
    return;
  }
  let remaining = Math.min(Math.max(0, dtSeconds), MAX_DT);
  while (remaining > 1e-9) {
    const dt = Math.min(FIXED_STEP, remaining);
    state.vx += (state.stiffness * (targetX - state.x) - state.damping * state.vx) * dt;
    state.vy += (state.stiffness * (targetY - state.y) - state.damping * state.vy) * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;
    remaining -= dt;
  }
};

export interface MotionTargets {
  readonly cx: number;
  readonly cy: number;
  readonly gx: number;
  readonly gy: number;
  readonly ox: number;
  readonly oy: number;
}

export interface VisualMotion {
  readonly centroid: MotionState;
  readonly gaze: MotionState;
  readonly offset: MotionState;
  advance(targets: MotionTargets, dt: number, reducedMotion: boolean): void;
}

// Bundles the three scene springs: centroid/gaze at 14/5 (slow, readable jelly
// — party viewers need ~1s to watch a transition) and the adhesion offset at
// 10/4 (even slower so the drift toward a surface reads as deliberate).
export const createVisualMotion = (x: number, y: number, gx: number, gy: number): VisualMotion => {
  const centroid = createMotionState(x, y, 14, 5);
  const gaze = createMotionState(gx, gy, 14, 5);
  const offset = createMotionState(0, 0, 10, 4);
  return {
    centroid,
    gaze,
    offset,
    advance: (t, dt, reducedMotion) => {
      advanceMotion(centroid, t.cx, t.cy, dt, reducedMotion);
      advanceMotion(gaze, t.gx, t.gy, dt, reducedMotion);
      advanceMotion(offset, t.ox, t.oy, dt, reducedMotion);
    },
  };
};
