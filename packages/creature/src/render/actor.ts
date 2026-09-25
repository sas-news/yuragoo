// Actor rig: owns the visual motion springs and positions body/face/effects/
// links around the actor center (visual centroid + clamped visual offset).
import type { Graphics } from "pixi.js";
import type { AttractionSample } from "../attraction";
import type { PoseSnapshot } from "../pose";
import type { AttractorLayer } from "./attractors";
import type { CreatureEffects } from "./effects";
import type { CreatureFace } from "./face";
import type { CreatureExpression } from "./lifecycle";
import type { CreatureMesh } from "./mesh";
import { createVisualMotion, type VisualMotion } from "./motion";
import {
  clampActorOffset,
  contourRadiusAt,
  directionOf,
  runnerUpIndex,
  strongestIndex,
} from "./presentation";

const ADHERE_OFFSET_RATIO = 0.45;
const SURFACE_DEPTH = 0.8;
const FACE_OFFSET_RATIO = 0.16;

export interface ActorFrame {
  readonly snapshot: PoseSnapshot;
  readonly normalized: readonly AttractionSample[];
  readonly expression: CreatureExpression;
  readonly reducedMotion: boolean;
  readonly elapsedSeconds: number;
  readonly adhesionProgress: number;
  readonly adhereMax: number;
  readonly orbit: number;
  readonly scale: number;
  readonly stageWidth: number;
  readonly stageHeight: number;
}

export interface ActorRig {
  readonly visual: VisualMotion;
  readonly center: { x: number; y: number };
  readonly surface: { x: number; y: number };
  advance(frame: ActorFrame, dt: number): void;
  sync(frame: ActorFrame): void;
  aimSurface(frame: ActorFrame, dx: number, dy: number): void;
}

interface ActorParts {
  readonly body: CreatureMesh;
  readonly shadow: Graphics;
  readonly highlight: Graphics;
  readonly face: CreatureFace;
  readonly effects: CreatureEffects;
  readonly layer: AttractorLayer;
}

export const createActorRig = (parts: ActorParts, initial: PoseSnapshot): ActorRig => {
  const { body, shadow, highlight, face, effects, layer } = parts;
  const visual = createVisualMotion(
    initial.centroid.x,
    initial.centroid.y,
    initial.gaze.x,
    initial.gaze.y,
  );
  const center = { x: 0, y: 0 };
  const surface = { x: 0, y: 0 };
  const desired = { x: 0, y: 0 };
  const clampOffset = (frame: ActorFrame, offset: { x: number; y: number }) =>
    clampActorOffset(
      frame.snapshot,
      frame.scale,
      frame.stageWidth,
      frame.stageHeight,
      offset,
      8,
      visual.centroid,
    );

  const advance = (frame: ActorFrame, dt: number): void => {
    const dominant = frame.snapshot.dominantAngleRad;
    const magnitude =
      frame.orbit * ADHERE_OFFSET_RATIO * (frame.adhesionProgress / frame.adhereMax);
    desired.x = (dominant === null ? 0 : Math.cos(dominant)) * magnitude;
    desired.y = (dominant === null ? 0 : Math.sin(dominant)) * magnitude;
    const target = clampOffset(frame, desired);
    const gaze =
      frame.expression === "hesitating"
        ? directionOf(frame.normalized, strongestIndex(frame.normalized))
        : frame.snapshot.gaze;
    visual.advance(
      {
        cx: frame.snapshot.centroid.x,
        cy: frame.snapshot.centroid.y,
        gx: gaze.x,
        gy: gaze.y,
        ox: target.x,
        oy: target.y,
      },
      dt,
      frame.reducedMotion,
    );
  };

  // Leading-surface emission point in scene-local logical units along `dir`.
  const aimSurface = (frame: ActorFrame, dx: number, dy: number): void => {
    const inv = Math.hypot(dx, dy) > 1e-9 ? 1 / Math.hypot(dx, dy) : 0;
    const radius = contourRadiusAt(frame.snapshot.contour, Math.atan2(dy * inv, dx * inv));
    surface.x = center.x / frame.scale + dx * inv * SURFACE_DEPTH * radius;
    surface.y = center.y / frame.scale + dy * inv * SURFACE_DEPTH * radius;
    effects.setOrigin(surface.x, surface.y);
  };

  const sync = (frame: ActorFrame): void => {
    const bounded = clampOffset(frame, visual.offset);
    visual.offset.x = bounded.x;
    visual.offset.y = bounded.y;
    center.x = visual.centroid.x * frame.scale + bounded.x;
    center.y = visual.centroid.y * frame.scale + bounded.y;
    body.view.position.set(bounded.x, bounded.y);
    highlight.position.set(center.x, center.y);
    shadow.position.set(bounded.x * 0.4, bounded.y * 0.35);
    shadow.alpha = 1 - frame.adhesionProgress * 0.6;
    const alt = directionOf(frame.normalized, runnerUpIndex(frame.normalized));
    face.root.position.set(
      center.x + visual.gaze.x * FACE_OFFSET_RATIO * frame.scale,
      center.y + visual.gaze.y * FACE_OFFSET_RATIO * frame.scale,
    );
    face.update({
      gazeX: visual.gaze.x,
      gazeY: visual.gaze.y,
      altGazeX: alt.x,
      altGazeY: alt.y,
      expression: frame.expression,
      reducedMotion: frame.reducedMotion,
      elapsedSeconds: frame.elapsedSeconds,
    });
    aimSurface(frame, visual.gaze.x, visual.gaze.y);
    layer.update(frame.normalized, center.x, center.y);
  };

  return { visual, center, surface, advance, sync, aimSurface };
};
