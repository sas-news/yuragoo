import { createAttractionField, type AttractionSample, type Vec2 } from "./attraction";
import {
  CONTOUR_POINT_COUNT,
  contourArea,
  contourPoints,
  correctArea,
  createRestRadii,
  createTargetRadii,
  type ContourPoint,
} from "./contour";
import { advanceSpring, createSpringState, type SpringState } from "./spring";

export interface SimulationClock {
  nowMs(): number;
}

export interface RandomSource {
  next(): number;
}

export interface PoseDependencies {
  readonly clock: SimulationClock;
  readonly random: RandomSource;
}

export interface PoseSnapshot {
  readonly contour: readonly ContourPoint[];
  readonly centroid: Vec2;
  readonly gaze: Vec2;
  readonly dominantAngleRad: number | null;
  readonly dominance: number;
  readonly area: number;
}

export interface PoseSimulation {
  readonly state: SpringState;
  advance(samples: readonly AttractionSample[]): PoseSnapshot;
  advanceBy(samples: readonly AttractionSample[], dtSeconds: number): PoseSnapshot;
  snapshot(samples: readonly AttractionSample[]): PoseSnapshot;
}

export function createPoseSimulation(
  dependencies: PoseDependencies,
  restRadius = 1,
): PoseSimulation {
  if (!Number.isFinite(restRadius) || restRadius <= 0) {
    throw new RangeError("restRadius must be a finite number > 0");
  }
  const startMs = dependencies.clock.nowMs();
  if (!Number.isFinite(startMs)) {
    throw new RangeError("clock.nowMs() must return a finite number");
  }
  const radii = createRestRadii(restRadius);
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    const u = dependencies.random.next();
    if (!Number.isFinite(u) || u < 0 || u > 1) {
      throw new RangeError("random.next() must return a finite value in [0,1]");
    }
    radii[i] = restRadius * (1 + (u - 0.5) * 0.01);
  }
  correctArea(radii, restRadius);
  const state = createSpringState(radii);
  let lastMs = startMs;

  const snapshot = (samples: readonly AttractionSample[]): PoseSnapshot => {
    const field = createAttractionField(samples);
    return {
      contour: contourPoints(state.radii),
      centroid: field.centroid,
      gaze: field.gaze,
      dominantAngleRad: field.dominantAngleRad,
      dominance: field.dominance,
      area: contourArea(state.radii),
    };
  };

  const advanceBy = (samples: readonly AttractionSample[], dtSeconds: number): PoseSnapshot => {
    const targets = createTargetRadii(samples, restRadius);
    advanceSpring(state, targets, dtSeconds, restRadius);
    return snapshot(samples);
  };

  const advance = (samples: readonly AttractionSample[]): PoseSnapshot => {
    const now = dependencies.clock.nowMs();
    if (!Number.isFinite(now)) {
      throw new RangeError("clock.nowMs() must return a finite number");
    }
    const dtSeconds = (now - lastMs) / 1000;
    if (dtSeconds < 0) {
      throw new RangeError("clock moved backward");
    }
    const result = advanceBy(samples, dtSeconds);
    lastMs = now;
    return result;
  };

  return { state, advance, advanceBy, snapshot };
}
