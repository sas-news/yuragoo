import { normalizeAttractions, type AttractionSample } from "./attraction";

const TAU = Math.PI * 2;
const LOBE_HEIGHT = 1.25;
const KAPPA_NARROW = 9;
const KAPPA_WIDE = 4;
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.2;

export const CONTOUR_POINT_COUNT = 64;

export interface ContourPoint {
  readonly angleRad: number;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
}

function checkRestRadius(restRadius: number): void {
  if (!Number.isFinite(restRadius) || restRadius <= 0) {
    throw new RangeError("restRadius must be a finite number > 0");
  }
}

function checkRadii(radii: Float64Array): void {
  if (radii.length !== CONTOUR_POINT_COUNT) {
    throw new RangeError(`radii must contain ${CONTOUR_POINT_COUNT} entries`);
  }
  for (const r of radii) {
    if (!Number.isFinite(r)) {
      throw new RangeError("radii must be finite");
    }
  }
}

function clampRadius(r: number, restRadius: number): number {
  return Math.min(MAX_RATIO * restRadius, Math.max(MIN_RATIO * restRadius, r));
}

export function createRestRadii(restRadius = 1): Float64Array {
  checkRestRadius(restRadius);
  return new Float64Array(CONTOUR_POINT_COUNT).fill(restRadius);
}

export function contourPoints(radii: Float64Array): readonly ContourPoint[] {
  checkRadii(radii);
  const points: ContourPoint[] = [];
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    const angleRad = (i * TAU) / CONTOUR_POINT_COUNT;
    const radius = radii[i] ?? 0;
    points.push({
      angleRad,
      radius,
      x: radius * Math.cos(angleRad),
      y: radius * Math.sin(angleRad),
    });
  }
  return points;
}

export function contourArea(radii: Float64Array): number {
  checkRadii(radii);
  let sum = 0;
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    sum += (radii[i] ?? 0) * (radii[(i + 1) % CONTOUR_POINT_COUNT] ?? 0);
  }
  return 0.5 * Math.sin(TAU / CONTOUR_POINT_COUNT) * sum;
}

export function createTargetRadii(
  samples: readonly AttractionSample[],
  restRadius = 1,
): Float64Array {
  checkRestRadius(restRadius);
  const normalized = normalizeAttractions(samples);
  const raw = new Float64Array(CONTOUR_POINT_COUNT);
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    const theta = (i * TAU) / CONTOUR_POINT_COUNT;
    let bump = 0;
    for (const s of normalized) {
      const kappa = KAPPA_NARROW - (KAPPA_NARROW - KAPPA_WIDE) * s.weight;
      bump += s.weight * Math.exp(kappa * (Math.cos(theta - s.angleRad) - 1));
    }
    raw[i] = clampRadius(restRadius * (1 + LOBE_HEIGHT * bump), restRadius);
  }
  const radii = new Float64Array(CONTOUR_POINT_COUNT);
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    const prev = raw[(i - 1 + CONTOUR_POINT_COUNT) % CONTOUR_POINT_COUNT] ?? 0;
    const next = raw[(i + 1) % CONTOUR_POINT_COUNT] ?? 0;
    radii[i] = (prev + 2 * (raw[i] ?? 0) + next) / 4;
  }
  correctArea(radii, restRadius);
  return radii;
}

export function correctArea(radii: Float64Array, restRadius = 1): void {
  checkRadii(radii);
  checkRestRadius(restRadius);
  const target =
    0.5 * CONTOUR_POINT_COUNT * Math.sin(TAU / CONTOUR_POINT_COUNT) * restRadius * restRadius;
  for (let iter = 0; iter < 4; iter++) {
    const area = contourArea(radii);
    if (!(area > 0)) {
      break;
    }
    const scale = Math.sqrt(target / area);
    for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
      radii[i] = clampRadius((radii[i] ?? 0) * scale, restRadius);
    }
    if (Math.abs(contourArea(radii) - target) <= 0.01 * target) {
      break;
    }
  }
}
