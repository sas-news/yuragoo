// Pure-logic coverage for the Task 30 snapshot modules: pull shaping,
// canonical pose determinism, the eventId pose registry, and the FIFO
// image cache. The Pixi-backed capture path is exercised by
// tests/e2e/story/snapshots.spec.ts — here the source is stubbed.
import { expect, test } from "bun:test";
import * as C from "@yuragoo/creature";

const TAU = Math.PI * 2;
const totalWeight = (samples: readonly C.AttractionSample[]): number =>
  samples.reduce((sum, s) => sum + s.weight, 0);
const strongest = (samples: readonly C.AttractionSample[]): number => {
  let best = 0;
  samples.forEach((s, i) => {
    if (s.weight > (samples[best]?.weight ?? -1)) best = i;
  });
  return best;
};
const json = (value: unknown): string => JSON.stringify(value);
// Angles normalize to [0, 2PI): -PI/2 reads back as 3PI/2 — compare on the circle.
const wrappedAngleDelta = (a: number | null, b: number): number =>
  a === null ? TAU : Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const stubSource = (): { source: C.PanelImageSource; calls: () => number } => {
  let calls = 0;
  return {
    source: {
      extractImage: () => Promise.resolve(new Blob([`png-${++calls}`], { type: "image/png" })),
    },
    calls: () => calls,
  };
};

test("happy: null pull replays four uniform rest slots", () => {
  const samples = C.replaySamples(null);
  expect(samples).toHaveLength(4);
  for (const s of samples) expect(s.weight).toBeCloseTo(0.25, 9);
  const angles = C.CANONICAL_SLOT_ANGLES[4] ?? [];
  samples.forEach((s, i) => {
    expect(s.angleRad).toBe(angles[i] ?? Number.NaN);
  });
});

test("happy: pull index rides the canonical slot angle, cubed and renormalized", () => {
  // Same shaping as room-arena's live lean: cube the raw probability,
  // renormalize, pin slot i to canonical angle i.
  const samples = C.replaySamples([0.6, 0.3, 0.1]);
  expect(samples).toHaveLength(3);
  const angles = C.CANONICAL_SLOT_ANGLES[3] ?? [];
  samples.forEach((s, i) => {
    expect(s.angleRad).toBe(angles[i] ?? Number.NaN);
  });
  expect(totalWeight(samples)).toBeCloseTo(1, 9);
  const cube = [0.216, 0.027, 0.001];
  const cubeTotal = 0.244;
  samples.forEach((s, i) => {
    expect(s.weight).toBeCloseTo((cube[i] ?? 0) / cubeTotal, 9);
  });
  expect(strongest(samples)).toBe(0);
});

test("happy: a true tie stays exactly uniform after shaping", () => {
  const samples = C.replaySamples([0.5, 0.5, 0.5, 0.5]);
  for (const s of samples) expect(s.weight).toBeCloseTo(0.25, 9);
});

test("happy: canonicalPose is deterministic — same pull, same silhouette", () => {
  const pull = [0.6, 0.25, 0.1, 0.05];
  const first = C.canonicalPose(pull);
  const second = C.canonicalPose(pull);
  expect(json(second)).toBe(json(first));
  // And the settled dominant direction is slot 0's canonical angle (-PI/2).
  expect(wrappedAngleDelta(first.dominantAngleRad, -TAU / 4)).toBeLessThan(1e-9);
  expect(first.dominance).toBeGreaterThan(0.5);
  expect(first.area).toBeGreaterThan(0);
  // A different pull must not collide with the same silhouette.
  expect(json(C.canonicalPose([0.05, 0.8, 0.1, 0.05]))).not.toBe(json(first));
});

test("happy: capturePose records by eventId and memoizes identical input", () => {
  C.clearCapturedPoses();
  const pull = [0.6, 0.25, 0.1, 0.05];
  const captured = C.capturePose(7, pull);
  expect(captured.eventId).toBe(7);
  expect(captured.rendererVersion).toBe(C.RENDERER_VERSION);
  expect(captured.pull).toEqual(pull);
  // Same eventId + same pull returns the memoized entry — no re-simulate.
  expect(C.capturePose(7, [...pull])).toBe(captured);
  expect(C.poseForEvent(7)).toBe(captured);
  // A different pull for the same eventId re-captures (epoch mismatch).
  const other = C.capturePose(7, null);
  expect(other).not.toBe(captured);
  expect(other.pull).toBeNull();
  expect(C.poseForEvent(7)).toBe(other);
  expect(C.poseForEvent(404)).toBeNull();
  C.clearCapturedPoses();
  expect(C.poseForEvent(7)).toBeNull();
});

test("happy: input pull arrays are copied, not aliased", () => {
  C.clearCapturedPoses();
  const pull = [0.6, 0.25, 0.1, 0.05];
  const captured = C.capturePose(9, pull);
  pull[0] = 0;
  expect(captured.pull).toEqual([0.6, 0.25, 0.1, 0.05]);
  C.clearCapturedPoses();
});

test("happy: panel images cache by eventId and memoize repeat captures", async () => {
  C.releaseAll();
  const { source, calls } = stubSource();
  const blob = await C.capturePanelImage(source, 1);
  expect(blob).not.toBeNull();
  expect(blob?.type).toBe("image/png");
  expect(C.panelImage(1)).toBe(blob);
  expect(await C.capturePanelImage(source, 1)).toBe(blob);
  expect(calls()).toBe(1);
  C.releaseAll();
});

test("happy: the image cache evicts FIFO once past the panel cap", async () => {
  C.releaseAll();
  const { source } = stubSource();
  for (const id of [11, 12, 13, 14, 15, 16]) {
    await C.capturePanelImage(source, id);
  }
  expect(C.size()).toBe(C.MAX_PANEL_IMAGES);
  expect(C.panelImage(11)).toBeNull();
  for (const id of [12, 13, 14, 15, 16]) expect(C.panelImage(id)).not.toBeNull();
  // Re-capturing a still-cached id refreshes its eviction slot without
  // re-extracting (memoized hit path).
  const oldest = C.panelImage(12);
  await C.capturePanelImage(source, 12);
  expect(C.panelImage(12)).toBe(oldest);
  await C.capturePanelImage(source, 17);
  expect(C.size()).toBe(C.MAX_PANEL_IMAGES);
  // Refreshed 12 survives; 13 (now oldest untouched) is evicted.
  expect(C.panelImage(13)).toBeNull();
  expect(C.panelImage(12)).not.toBeNull();
  C.releaseAll();
});

test("failure: a null capture is not cached and release() drops one entry", async () => {
  C.releaseAll();
  const empty: C.PanelImageSource = { extractImage: () => Promise.resolve(null) };
  expect(await C.capturePanelImage(empty, 21)).toBeNull();
  expect(C.size()).toBe(0);
  const { source } = stubSource();
  await C.capturePanelImage(source, 21);
  C.release(21);
  expect(C.panelImage(21)).toBeNull();
  expect(C.size()).toBe(0);
  C.releaseAll();
});
