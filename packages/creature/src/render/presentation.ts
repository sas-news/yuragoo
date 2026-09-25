import type { AttractionSample, Vec2 } from "../attraction";
import type { ContourPoint } from "../contour";
import type { PoseSnapshot } from "../pose";

const TAU = Math.PI * 2;

// Interpolated contour radius at an arbitrary angle; used to place particles
// on the leading body surface rather than at the actor center.
export const contourRadiusAt = (contour: readonly ContourPoint[], angleRad: number): number => {
  const n = contour.length;
  if (n === 0) return 0;
  const u = (((angleRad % TAU) + TAU) % TAU) * (n / TAU);
  const i0 = Math.floor(u) % n;
  const i1 = (i0 + 1) % n;
  const a = contour[i0]?.radius ?? 0;
  const b = contour[i1]?.radius ?? 0;
  return a + (b - a) * (u - Math.floor(u));
};

export const strongestIndex = (samples: readonly AttractionSample[]): number => {
  let index = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i]?.weight ?? 0) > (samples[index]?.weight ?? 0)) index = i;
  }
  return index;
};

export const runnerUpIndex = (samples: readonly AttractionSample[]): number => {
  let first = 0;
  let second = samples.length > 1 ? 1 : 0;
  for (let i = 1; i < samples.length; i += 1) {
    const weight = samples[i]?.weight ?? 0;
    if (weight > (samples[first]?.weight ?? 0)) {
      second = first;
      first = i;
    } else if (weight > (samples[second]?.weight ?? 0)) {
      second = i;
    }
  }
  return second;
};

export const directionOf = (samples: readonly AttractionSample[], index: number): Vec2 => {
  const angle = samples[index]?.angleRad ?? 0;
  return { x: Math.cos(angle), y: Math.sin(angle) };
};

export const sameNormalizedSamples = (
  a: readonly AttractionSample[],
  b: readonly AttractionSample[],
): boolean =>
  a.length === b.length &&
  a.every((sample, i) => {
    const other = b[i];
    return (
      other !== undefined && other.angleRad === sample.angleRad && other.weight === sample.weight
    );
  });

// Clamps the desired actor offset so the dynamic body contour stays `inset`
// pixels inside every stage edge for any adhesion direction or blob shape.
export const clampActorOffset = (
  snapshot: PoseSnapshot,
  scale: number,
  stageWidth: number,
  stageHeight: number,
  desired: Vec2,
  inset = 8,
  center?: Vec2,
): Vec2 => {
  const basis = center ?? snapshot.centroid;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const point of snapshot.contour) {
    const x = (point.x + basis.x) * scale;
    const y = (point.y + basis.y) * scale;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    x: Math.min(Math.max(desired.x, -stageWidth / 2 + inset - minX), stageWidth / 2 - inset - maxX),
    y: Math.min(
      Math.max(desired.y, -stageHeight / 2 + inset - minY),
      stageHeight / 2 - inset - maxY,
    ),
  };
};
