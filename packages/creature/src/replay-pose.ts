// Canonical pose replay (Task 30): rebuilds the exact silhouette a panel
// depicts from the persisted pull vector alone. Scene-mount simulations
// all use the same fixed deps — clock 0 and random.next()=0.5 (see
// render/scene.ts), which zeroes the rest-radius jitter — so every client
// already renders the identical blob and no event seed is needed. This
// module must stay pure and Pixi-free so it can run anywhere (worker,
// test, future server re-render).

import type { AttractionSample } from "./attraction";
import { createPoseSimulation, type PoseSnapshot } from "./pose";
import { CANONICAL_SLOT_ANGLES } from "./render/attractors";
import { FIXED_STEP_SECONDS } from "./spring";

// Presentation gain, shared with room-arena's live pull shaping: Jev's
// verdicts are gentle (0.45/0.30/0.25 is already a firm answer), so raw
// probabilities read as a barely-off-center drift. Cubing sharpens the
// lean into a readable pull — ranking is untouched and a true tie stays
// exactly uniform. Panels replay what players saw, so both paths must
// use the same gain.
export const PULL_GAIN = 3;

// A null pull means "the creature at rest" (the start panel). The lab and
// the DEFAULT_PRESENTATION scene both rest on four uniform attractors, so
// the canonical rest pose does too — a 2- or 6-slot rest would depict a
// different creature than the one players watched.
const REST_SLOT_COUNT = 4;

// Fixed settle window: the spring needs ~4s for every coupled mode to
// fall below 0.02 rest/s (the same bound dynamics.test.ts asserts).
const SETTLE_SECONDS = 4;

// Pull -> attraction samples: slot i rides canonical angle i, weights are
// cubed then renormalized — the same shaping as room-arena.roomSamples.
// Pull length is already clamped to [2,6] by the story contract; the
// clamp below keeps a malformed panel from throwing mid-story.
export function replaySamples(pull: readonly number[] | null): AttractionSample[] {
  const count = pull === null ? REST_SLOT_COUNT : Math.min(6, Math.max(2, pull.length));
  const angles = CANONICAL_SLOT_ANGLES[count] ?? [];
  const uniform = 1 / count;
  const shaped = Array.from({ length: count }, (_, i) => (pull?.[i] ?? uniform) ** PULL_GAIN);
  const total = shaped.reduce((sum, w) => sum + w, 0);
  return shaped.map((weight, i) => ({
    angleRad: angles[i] ?? 0,
    weight: weight / (total > 0 ? total : 1),
  }));
}

// The canonical pose for one panel: a fresh simulation with the same fixed
// deps scene.ts mounts with, driven by the replayed samples through the
// settle window at the physics step. Same pull in, same silhouette out.
export function canonicalPose(pull: readonly number[] | null): PoseSnapshot {
  const samples = replaySamples(pull);
  const sim = createPoseSimulation({
    clock: { nowMs: () => 0 },
    random: { next: () => 0.5 },
  });
  let snapshot = sim.snapshot(samples);
  const steps = Math.round(SETTLE_SECONDS / FIXED_STEP_SECONDS);
  for (let i = 0; i < steps; i += 1) {
    snapshot = sim.advanceBy(samples, FIXED_STEP_SECONDS);
  }
  return snapshot;
}
