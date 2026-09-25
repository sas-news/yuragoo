import { CONTOUR_POINT_COUNT, correctArea } from "./contour";

export const FIXED_STEP_SECONDS = 1 / 120;
export const MAX_SUBSTEPS = 4;

const STIFFNESS = 20;
const DAMPING = 4.2;
const NEIGHBOR_SMOOTHING = 24;
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.2;

// Float64Array state is intentionally mutable: pose updates run per frame and must not allocate.
export interface SpringState {
  readonly radii: Float64Array;
  readonly velocities: Float64Array;
  accumulatorSeconds: number;
}

function checkState(state: SpringState): void {
  if (
    state.radii.length !== CONTOUR_POINT_COUNT ||
    state.velocities.length !== CONTOUR_POINT_COUNT
  ) {
    throw new RangeError(`spring state must contain ${CONTOUR_POINT_COUNT} entries`);
  }
}

export function createSpringState(initialRadii: Float64Array): SpringState {
  if (initialRadii.length !== CONTOUR_POINT_COUNT) {
    throw new RangeError(`initial radii must contain ${CONTOUR_POINT_COUNT} entries`);
  }
  for (const r of initialRadii) {
    if (!Number.isFinite(r)) {
      throw new RangeError("initial radii must be finite");
    }
  }
  return {
    radii: Float64Array.from(initialRadii),
    velocities: new Float64Array(CONTOUR_POINT_COUNT),
    accumulatorSeconds: 0,
  };
}

export function advanceSpring(
  state: SpringState,
  targets: Float64Array,
  dtSeconds: number,
  restRadius = 1,
): number {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
    throw new RangeError("dtSeconds must be a finite number >= 0");
  }
  if (targets.length !== CONTOUR_POINT_COUNT) {
    throw new RangeError(`targets must contain ${CONTOUR_POINT_COUNT} entries`);
  }
  for (const t of targets) {
    if (!Number.isFinite(t)) {
      throw new RangeError("targets must be finite");
    }
  }
  checkState(state);
  if (!Number.isFinite(restRadius) || restRadius <= 0) {
    throw new RangeError("restRadius must be a finite number > 0");
  }
  const min = MIN_RATIO * restRadius;
  const max = MAX_RATIO * restRadius;
  state.accumulatorSeconds += Math.min(dtSeconds, MAX_SUBSTEPS * FIXED_STEP_SECONDS);
  let steps = 0;
  const { radii, velocities } = state;
  while (state.accumulatorSeconds >= FIXED_STEP_SECONDS && steps < MAX_SUBSTEPS) {
    for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
      const r = radii[i] ?? 0;
      const prev = radii[(i - 1 + CONTOUR_POINT_COUNT) % CONTOUR_POINT_COUNT] ?? 0;
      const next = radii[(i + 1) % CONTOUR_POINT_COUNT] ?? 0;
      const accel =
        STIFFNESS * ((targets[i] ?? 0) - r) +
        NEIGHBOR_SMOOTHING * (prev - 2 * r + next) -
        DAMPING * (velocities[i] ?? 0);
      velocities[i] = (velocities[i] ?? 0) + accel * FIXED_STEP_SECONDS;
    }
    for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
      let v = velocities[i] ?? 0;
      const radius = (radii[i] ?? 0) + v * FIXED_STEP_SECONDS;
      if (radius < min && v < 0) v = 0;
      if (radius > max && v > 0) v = 0;
      radii[i] = Math.min(max, Math.max(min, radius));
      velocities[i] = v;
    }
    state.accumulatorSeconds -= FIXED_STEP_SECONDS;
    steps++;
  }
  if (state.accumulatorSeconds >= FIXED_STEP_SECONDS) {
    state.accumulatorSeconds = 0;
  }
  correctArea(radii, restRadius);
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    if (!Number.isFinite(velocities[i])) velocities[i] = 0;
  }
  return steps;
}
