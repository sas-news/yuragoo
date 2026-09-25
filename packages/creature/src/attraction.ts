const TAU = Math.PI * 2;

export interface AttractionSample {
  readonly angleRad: number;
  readonly weight: number;
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface AttractionField {
  readonly samples: readonly AttractionSample[];
  readonly centroid: Vec2;
  readonly gaze: Vec2;
  readonly dominantAngleRad: number | null;
  readonly dominance: number;
}

function validateSamples(samples: readonly AttractionSample[]): void {
  if (samples.length < 2 || samples.length > 6) {
    throw new RangeError("attraction sample count must be in [2,6]");
  }
  for (const s of samples) {
    if (!Number.isFinite(s.angleRad)) {
      throw new RangeError("attraction angle must be finite");
    }
    if (!Number.isFinite(s.weight) || s.weight < 0) {
      throw new RangeError("attraction weight must be a finite number >= 0");
    }
  }
}

export function normalizeAttractions(
  samples: readonly AttractionSample[],
): readonly AttractionSample[] {
  validateSamples(samples);
  const maxWeight = Math.max(...samples.map(({ weight }) => weight));
  const normalizedAngle = (a: number) => ((a % TAU) + TAU) % TAU;
  if (maxWeight === 0) {
    return samples.map((s) => ({
      angleRad: normalizedAngle(s.angleRad),
      weight: 1 / samples.length,
    }));
  }
  const scaled = samples.map(({ weight }) => weight / maxWeight);
  const scaledTotal = scaled.reduce((sum, weight) => sum + weight, 0);
  return samples.map((s, i) => ({
    angleRad: normalizedAngle(s.angleRad),
    weight: (scaled[i] ?? 0) / scaledTotal,
  }));
}

export function createAttractionField(samples: readonly AttractionSample[]): AttractionField {
  const normalized = normalizeAttractions(samples);
  let vx = 0;
  let vy = 0;
  let max = -1;
  let second = -1;
  let dominantAngleRad: number | null = null;
  for (const s of normalized) {
    vx += s.weight * Math.cos(s.angleRad);
    vy += s.weight * Math.sin(s.angleRad);
    if (s.weight > max) {
      second = max;
      max = s.weight;
      dominantAngleRad = s.angleRad;
    } else if (s.weight > second) {
      second = s.weight;
    }
  }
  const magnitude = Math.hypot(vx, vy);
  const gaze: Vec2 = magnitude > 1e-9 ? { x: vx / magnitude, y: vy / magnitude } : { x: 0, y: 0 };
  return {
    samples: normalized,
    centroid: { x: vx * 0.3, y: vy * 0.3 },
    gaze,
    dominantAngleRad,
    dominance: Math.min(1, Math.max(0, max - (second < 0 ? 0 : second))),
  };
}
