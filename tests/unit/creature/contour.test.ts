import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as C from "@yuragoo/creature";

const REST = 1;
const N = C.CONTOUR_POINT_COUNT;
const TAU = Math.PI * 2;
const REST_AREA = 0.5 * N * Math.sin(TAU / N);
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
const fakeClock = (start = 0) => {
  const box = { t: start };
  return { box, clock: { nowMs: () => box.t } };
};
const makeSim = (seed = 42) =>
  C.createPoseSimulation({ clock: fakeClock().clock, random: mulberry32(seed) }, REST);
const samples = (weights: readonly number[], offset = 0): C.AttractionSample[] =>
  weights.map((weight, i) => ({ angleRad: (i * TAU) / weights.length + offset, weight }));
const drive = (sim: ReturnType<typeof makeSim>, s: C.AttractionSample[], sec: number, fps = 60) => {
  for (let i = 0; i < Math.round(sec * fps); i++) sim.advanceBy(s, 1 / fps);
};
const settle = (s: C.AttractionSample[], seed = 42, sec = 2, fps = 60) => {
  const sim = makeSim(seed);
  drive(sim, s, sec, fps);
  return sim.snapshot(s);
};
const at = (pts: readonly C.ContourPoint[], i: number): C.ContourPoint => {
  const p = pts[i];
  if (!p) throw new Error(`missing point ${i}`);
  return p;
};
const radiusAt = (pts: readonly C.ContourPoint[], a: number) =>
  at(pts, ((Math.round((a / TAU) * N) % N) + N) % N).radius;
const cross = (o: C.ContourPoint, p: C.ContourPoint, q: C.ContourPoint) =>
  (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
const hasSelfIntersection = (pts: readonly C.ContourPoint[]): boolean => {
  const seg = (i: number) => [at(pts, i % N), at(pts, (i + 1) % N)] as const;
  const strict = (a: C.ContourPoint, b: C.ContourPoint, c: C.ContourPoint, d: C.ContourPoint) =>
    cross(c, d, a) * cross(c, d, b) < 0 && cross(a, b, c) * cross(a, b, d) < 0;
  for (let i = 0; i < N; i++)
    for (let j = i + 2; j < N - (i === 0 ? 1 : 0); j++)
      if (strict(...seg(i), ...seg(j))) return true;
  return false;
};
const uniform4 = samples([0.25, 0.25, 0.25, 0.25]);
const dominant4 = samples([0.7, 0.1, 0.1, 0.1]);
const six = samples([0.4, 0.2, 0.15, 0.1, 0.1, 0.05]);
const badSamples = [
  [{ angleRad: Number.NaN, weight: 1 }, ...samples([1, 1])],
  [{ angleRad: Number.POSITIVE_INFINITY, weight: 1 }, ...samples([1, 1])],
  [{ angleRad: 0, weight: Number.NaN }, ...samples([1, 1])],
  [{ angleRad: 0, weight: Number.POSITIVE_INFINITY }, ...samples([1, 1])],
  [{ angleRad: 0, weight: -1 }, ...samples([1, 1])],
];
test("happy: uniform four choices yield a finite ordered contour within area bounds", () => {
  // Given a sim settled 1s with uniform attraction, When snapshot taken
  const snap = settle(uniform4, 42, 1);
  // Then 64 finite points on strictly increasing fixed angles, area +-15%, no intersections
  expect(snap.contour.length).toBe(N);
  for (let i = 0; i < N; i++) {
    const p = at(snap.contour, i);
    expect(Number.isFinite(p.radius) && p.radius > 0).toBe(true);
    expect(p.angleRad).toBeCloseTo((i * TAU) / N, 10);
  }
  expect(Math.abs(snap.area - REST_AREA)).toBeLessThanOrEqual(0.15 * REST_AREA);
  expect(hasSelfIntersection(snap.contour)).toBe(false);
});
test("happy: dominant choice stretches toward it; split grows lobes toward both poles", () => {
  // Given 0.7-dominant and 0.5/0.5-split inputs each settled 2s
  const dom = settle(dominant4, 7);
  const split = settle(samples([0.5, 0, 0.5, 0]), 11);
  // Then dominant radius exceeds opposite by >=5% rest and gaze/centroid point that way
  expect(radiusAt(dom.contour, 0) - radiusAt(dom.contour, Math.PI)).toBeGreaterThanOrEqual(
    0.05 * REST,
  );
  expect(dom.centroid.x).toBeGreaterThan(0);
  expect(dom.gaze.x).toBeGreaterThan(0.9);
  expect(dom.dominantAngleRad).toBeCloseTo(0, 10);
  // And both split poles exceed the perpendicular direction
  const perp = radiusAt(split.contour, Math.PI / 2);
  expect(radiusAt(split.contour, 0)).toBeGreaterThan(perp);
  expect(radiusAt(split.contour, Math.PI)).toBeGreaterThan(perp);
});
test("happy: six nonuniform directions keep the strongest lobe largest", () => {
  // Given six decreasing weights settled 2s
  const snap = settle(six, 23);
  // Then all finite and strongest lobe exceeds weakest by >=2% rest
  for (const p of snap.contour) expect(Number.isFinite(p.radius)).toBe(true);
  expect(radiusAt(snap.contour, 0) - radiusAt(snap.contour, (5 * TAU) / 6)).toBeGreaterThanOrEqual(
    0.02 * REST,
  );
});
test("happy: same seed at 30/60/120fps and repeated 60fps converge identically", () => {
  // Given identical seeds driven 2s at three frame rates plus a repeated 60fps run
  const finals = [30, 60, 120, 60].map((fps) => {
    const sim = makeSim(99);
    drive(sim, dominant4, 2, fps);
    return Array.from(sim.state.radii);
  });
  const [a, b, c, d] = finals;
  if (!a || !b || !c || !d) throw new Error("missing run");
  // Then radii differ by <=0.02*rest across frame rates and match exactly at same seed+fps
  for (let i = 0; i < N; i++) {
    expect(Math.abs((a[i] ?? 0) - (b[i] ?? 0))).toBeLessThanOrEqual(0.02 * REST);
    expect(Math.abs((b[i] ?? 0) - (c[i] ?? 0))).toBeLessThanOrEqual(0.02 * REST);
    expect(b[i]).toBe(d[i]);
  }
});
test("happy: release to neutral decays velocity below its transient peak", () => {
  // Given a driven strong pose released into uniform attraction
  const sim = makeSim(5);
  drive(sim, dominant4, 2);
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    sim.advanceBy(uniform4, 1 / 60);
    for (const v of sim.state.velocities) peak = Math.max(peak, Math.abs(v));
  }
  // When released 4s total, Then residual motion <0.02 and below the transient peak
  drive(sim, uniform4, 3.8);
  let finalMax = 0;
  for (const v of sim.state.velocities) finalMax = Math.max(finalMax, Math.abs(v));
  expect(peak).toBeGreaterThan(0.02);
  expect(finalMax).toBeLessThan(0.02);
  expect(finalMax).toBeLessThan(peak);
});
test("happy: rotated input yields rotated radii with no update-order bias", () => {
  // Given identical uniform spring states and targets rotated by PI/2 (16 slots)
  const stA = C.createSpringState(C.createRestRadii(REST));
  const stB = C.createSpringState(C.createRestRadii(REST));
  const tA = C.createTargetRadii(dominant4, REST);
  const tB = C.createTargetRadii(samples([0.7, 0.1, 0.1, 0.1], Math.PI / 2), REST);
  for (let i = 0; i < 120; i++) {
    C.advanceSpring(stA, tA, 1 / 60, REST);
    C.advanceSpring(stB, tB, 1 / 60, REST);
  }
  // Then B radii equal A radii circularly shifted by 16 indices within 1e-9
  for (let i = 0; i < N; i++) {
    const shifted = stA.radii[(i - 16 + N) % N] ?? 0;
    expect(Math.abs((stB.radii[i] ?? 0) - shifted)).toBeLessThanOrEqual(1e-9);
  }
});
test("failure: a 5-second dt executes at most 4 substeps without backlog burst", () => {
  // Given a spring state and a huge frame delta
  const state = C.createSpringState(C.createRestRadii(REST));
  const targets = C.createTargetRadii(dominant4, REST);
  // Then at most 4 substeps run, radii stay finite and in bounds
  expect(C.advanceSpring(state, targets, 5, REST)).toBeLessThanOrEqual(4);
  for (const r of state.radii) {
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(0.4 * REST - 1e-9);
    expect(r).toBeLessThanOrEqual(2.2 * REST + 1e-9);
  }
  // And the next normal frame shows no catch-up burst
  expect(C.advanceSpring(state, targets, 1 / 60, REST)).toBeLessThanOrEqual(2);
  for (const v of state.velocities) expect(Number.isFinite(v)).toBe(true);
});
test("happy: zero-total is uniform neutral and huge weights stay finite", () => {
  // Given four zero-weight samples
  const zero = samples([0, 0, 0, 0]);
  for (const s of C.normalizeAttractions(zero)) expect(s.weight).toBeCloseTo(0.25, 10);
  const field = C.createAttractionField(zero);
  // Then the field is centered with zero dominance
  expect(field.centroid.x).toBeCloseTo(0, 10);
  expect(field.gaze).toEqual({ x: 0, y: 0 });
  expect(field.dominance).toBeCloseTo(0, 10);
  // And two Number.MAX_VALUE weights normalize to a finite 0.5/0.5 split
  const huge = C.normalizeAttractions([
    { angleRad: 0, weight: Number.MAX_VALUE },
    { angleRad: 1, weight: Number.MAX_VALUE },
  ]);
  expect(huge[0]?.weight).toBeCloseTo(0.5, 12);
  expect(Number.isFinite(huge[1]?.weight)).toBe(true);
});
test("failure: invalid inputs throw RangeError without corrupting a valid state", () => {
  // Given a healthy simulation with snapshotted state
  const sim = makeSim(3);
  drive(sim, uniform4, 0.2);
  const radiiBefore = Array.from(sim.state.radii);
  const velBefore = Array.from(sim.state.velocities);
  // Then each invalid input throws RangeError: bad count, bad angle/weight, bad dt,
  // invalid rest radius, NaN clock, NaN or out-of-range random
  const mk = (s: readonly C.AttractionSample[]) => () => C.normalizeAttractions(s);
  const bad: (() => unknown)[] = [
    mk([]),
    mk(samples([1])),
    mk(samples([1, 1, 1, 1, 1, 1, 1])),
    ...badSamples.map(mk),
    () => sim.advanceBy(uniform4, -0.5),
    () => sim.advanceBy(uniform4, Number.NaN),
    () => sim.advanceBy(badSamples[0] ?? [], 1 / 60),
    () => C.createPoseSimulation({ clock: fakeClock().clock, random: mulberry32(1) }, 0),
    () => C.createPoseSimulation({ clock: { nowMs: () => Number.NaN }, random: mulberry32(1) }),
    () => C.createPoseSimulation({ clock: fakeClock().clock, random: { next: () => Number.NaN } }),
    () => C.createPoseSimulation({ clock: fakeClock().clock, random: { next: () => 1.5 } }),
  ];
  for (const fn of bad) expect(fn).toThrow(RangeError);
  const { box, clock } = fakeClock(100);
  const timed = C.createPoseSimulation({ clock, random: mulberry32(9) });
  box.t = 50;
  expect(() => timed.advance(uniform4)).toThrow(RangeError);
  // And neither radii nor velocities changed, and the sim still advances cleanly
  expect(Array.from(sim.state.radii)).toEqual(radiiBefore);
  expect(Array.from(sim.state.velocities)).toEqual(velBefore);
  expect(Number.isFinite(sim.advanceBy(uniform4, 1 / 60).area)).toBe(true);
});
test("failure: creation consumes the random source exactly 64 times", () => {
  // Given an instrumented random source
  let calls = 0;
  const random = {
    next: () => {
      calls++;
      return 0.5;
    },
  };
  // When a simulation is created, Then exactly 64 values are consumed
  C.createPoseSimulation({ clock: fakeClock().clock, random });
  expect(calls).toBe(N);
});
test("failure: rejected samples do not consume the clock or mutate state", () => {
  // Given two same-seed sims whose clocks both advance one frame
  const { box: boxA, clock: clockA } = fakeClock(0);
  const { box: boxB, clock: clockB } = fakeClock(0);
  const a = C.createPoseSimulation({ clock: clockA, random: mulberry32(31) });
  const b = C.createPoseSimulation({ clock: clockB, random: mulberry32(31) });
  boxA.t = 16.6;
  boxB.t = 16.6;
  // When A receives invalid samples it throws without consuming the clock
  expect(() => a.advance(badSamples[0] ?? [])).toThrow(RangeError);
  a.advance(uniform4);
  b.advance(uniform4);
  // Then A and B end in identical states
  expect(Array.from(a.state.radii)).toEqual(Array.from(b.state.radii));
  expect(Array.from(a.state.velocities)).toEqual(Array.from(b.state.velocities));
});
test("failure: computation modules never read global clock or random", () => {
  // Given the four computation sources, Then no global clock/random tokens appear
  for (const name of ["pose", "contour", "spring", "attraction"]) {
    const text = readFileSync(`packages/creature/src/${name}.ts`, "utf8");
    expect(/Date\.now|performance\.now|Math\.random/.test(text)).toBe(false);
  }
});
