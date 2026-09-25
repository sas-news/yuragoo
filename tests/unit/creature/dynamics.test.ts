// Focused dynamics tests for the tuned spring/attraction constants: visible
// lobe pull, overshoot on dominant switch, bounded release, and rate-stable
// endpoints. Shared helpers live here so contour.test.ts stays untouched.
import { expect, test } from "bun:test";
import * as C from "@yuragoo/creature";

const REST = 1;
const N = C.CONTOUR_POINT_COUNT;
const TAU = Math.PI * 2;
const mulberry32 = (seed: number): C.RandomSource => {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = Math.imul(s ^ (s >>> 15), s | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  return { next };
};
const makeSim = (seed = 42): C.PoseSimulation =>
  C.createPoseSimulation({ clock: { nowMs: () => 0 }, random: mulberry32(seed) }, REST);
const samples = (weights: readonly number[], offset = 0): C.AttractionSample[] =>
  weights.map((weight, i) => ({ angleRad: (i * TAU) / weights.length + offset, weight }));
const dominant4 = samples([0.7, 0.1, 0.1, 0.1]);
const uniform4 = samples([0.25, 0.25, 0.25, 0.25]);
const at = (pts: readonly C.ContourPoint[], i: number): C.ContourPoint => {
  const p = pts[i];
  if (!p) throw new Error(`missing contour point ${i}`);
  return p;
};
const radiusAt = (pts: readonly C.ContourPoint[], a: number) =>
  at(pts, ((Math.round((a / TAU) * N) % N) + N) % N).radius;
const radiusIndex = (a: number) => ((Math.round((a / TAU) * N) % N) + N) % N;
const drive = (sim: C.PoseSimulation, s: C.AttractionSample[], seconds: number, fps = 60): void => {
  for (let i = 0; i < Math.round(seconds * fps); i++) sim.advanceBy(s, 1 / fps);
};

test("happy: strong target pulls the dominant lobe >=0.12 rest beyond opposite", () => {
  // Given a 0.7-dominant field settled for two seconds
  const sim = makeSim(7);
  drive(sim, dominant4, 2);
  const snap = sim.snapshot(dominant4);
  // Then the lobe toward the dominant choice exceeds the opposite radius by >=0.12 rest
  expect(radiusAt(snap.contour, 0) - radiusAt(snap.contour, Math.PI)).toBeGreaterThanOrEqual(
    0.12 * REST,
  );
});
test("happy: switching dominant overshoots the new lobe target before settling", () => {
  // Given attraction A settled for two seconds, Then the field flips to B at PI/2
  const sim = makeSim(3);
  drive(sim, dominant4, 2);
  const bSamples = samples([0.7, 0.1, 0.1, 0.1], Math.PI / 2);
  const bIndex = radiusIndex(Math.PI / 2);
  const targetB = C.createTargetRadii(bSamples, REST)[bIndex];
  if (targetB === undefined) throw new Error("missing B target");
  // When we sample the B-direction radius for 1.5s at 120Hz
  let peak = 0;
  for (let i = 0; i < 180; i++) {
    sim.advanceBy(bSamples, 1 / 120);
    peak = Math.max(peak, sim.state.radii[bIndex] ?? 0);
  }
  // Then it visibly overshoots its settled target by >=0.01
  expect(peak).toBeGreaterThanOrEqual(targetB + 0.01);
});
test("happy: four seconds of neutral release settles finite below 0.02 velocity", () => {
  // Given a driven strong pose released into a uniform field — the retuned
  // spring (period ~1.4s) needs ~4s for all coupled modes to fall below 0.02
  const sim = makeSim(5);
  drive(sim, dominant4, 2);
  drive(sim, uniform4, 4);
  // Then every radius/velocity is finite and residual velocity is under 0.02
  let maxVelocity = 0;
  for (const v of sim.state.velocities) {
    expect(Number.isFinite(v)).toBe(true);
    maxVelocity = Math.max(maxVelocity, Math.abs(v));
  }
  for (const r of sim.state.radii) expect(Number.isFinite(r)).toBe(true);
  expect(maxVelocity).toBeLessThan(0.02);
});
test("happy: 30/60/120Hz endpoints agree within 0.02 for identical seeds", () => {
  // Given identical seeds driven two seconds at three frame rates
  const finals = [30, 60, 120].map((fps) => {
    const sim = makeSim(99);
    drive(sim, dominant4, 2, fps);
    return Array.from(sim.state.radii);
  });
  const [a, b, c] = finals;
  if (!a || !b || !c) throw new Error("missing run");
  // Then every endpoint radius differs by <=0.02 across rates
  for (let i = 0; i < N; i++) {
    expect(Math.abs((a[i] ?? 0) - (b[i] ?? 0))).toBeLessThanOrEqual(0.02);
    expect(Math.abs((b[i] ?? 0) - (c[i] ?? 0))).toBeLessThanOrEqual(0.02);
  }
});
