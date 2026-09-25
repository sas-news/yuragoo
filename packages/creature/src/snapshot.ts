// Pose capture registry (Task 30): maps a panel's eventId (events.seq) to
// the canonical pose replayed from its pull vector, so the kamishibai can
// look a panel up without re-running the spring per render. The capture
// is pure data — no Pixi, no renderer handle — which is what lets a
// reconnecting client redraw the identical silhouette from the event
// log alone. rendererVersion pins the pose pipeline: if scene.ts tuning
// ever changes the silhouette, bump RENDERER_VERSION so stale captures
// fall back instead of rendering a pose players never saw. Kept in sync
// with rendererVersion re-exported by index.ts.
import { canonicalPose } from "./replay-pose";
import type { PoseSnapshot } from "./pose";

export const RENDERER_VERSION = 1;

export interface CapturedPose {
  readonly eventId: number;
  readonly rendererVersion: number;
  readonly pull: readonly number[] | null;
  readonly pose: PoseSnapshot;
}

// The story shows at most one match's panels; a Map keyed by eventId
// stays trivially small and keeps the newest capture per event.
const captured = new Map<number, CapturedPose>();

const samePull = (a: readonly number[] | null, b: readonly number[] | null): boolean =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]));

// Records (or refreshes) the canonical pose for one panel. Same eventId +
// same pull replays the same silhouette, so a repeat capture is skipped;
// a different pull overwrites — eventIds are unique per match, so a
// mismatch means the earlier entry belonged to a different epoch.
export function capturePose(eventId: number, pull: readonly number[] | null): CapturedPose {
  const existing = captured.get(eventId);
  if (existing !== undefined && samePull(existing.pull, pull)) return existing;
  const next: CapturedPose = {
    eventId,
    rendererVersion: RENDERER_VERSION,
    pull: pull === null ? null : [...pull],
    pose: canonicalPose(pull),
  };
  captured.set(eventId, next);
  return next;
}

// Looks a capture up for rendering; null when nothing was recorded or
// the capture predates the current pose pipeline (callers then draw the
// template illustration instead of a mismatched silhouette).
export function poseForEvent(eventId: number): CapturedPose | null {
  const entry = captured.get(eventId);
  return entry !== undefined && entry.rendererVersion === RENDERER_VERSION ? entry : null;
}

// Drops every capture — called when the results view unmounts so poses
// from a finished match don't survive into a rematch epoch.
export function clearCapturedPoses(): void {
  captured.clear();
}
