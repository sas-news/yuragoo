import { Container, Graphics } from "pixi.js";
import { normalizeAttractions, type AttractionSample } from "../attraction";
import { createPoseSimulation, type PoseSimulation, type PoseSnapshot } from "../pose";
import { createActorRig, type ActorFrame } from "./actor";
import { createAttractorLayer } from "./attractors";
import { createCreatureEffects } from "./effects";
import { createCreatureFace } from "./face";
import type {
  CreatureExpression,
  CreaturePresentation,
  PoseRenderSummary,
  StageVisualState,
} from "./lifecycle";
import { BODY_ALPHA, createCreatureMesh, type CreatureMesh } from "./mesh";
import { CREATURE_COLORS } from "./materials";
import { directionOf, sameNormalizedSamples, strongestIndex } from "./presentation";

const FOCUS_COLOR = 0x2458d3;
const DANGER_COLOR = 0xb4233b;
const SCALE_RATIO = 0.22;
const MIN_SCALE = 40;
const LOADING_BODY_ALPHA = 0.45;
const ADHERE_SECONDS = 0.8;
const ADHERE_MAX = 0.92;

const SCENE_SAMPLES: readonly AttractionSample[] = [
  { angleRad: -Math.PI / 2, weight: 0.52 },
  { angleRad: 0, weight: 0.18 },
  { angleRad: Math.PI / 2, weight: 0.18 },
  { angleRad: Math.PI, weight: 0.12 },
];

export const DEFAULT_PRESENTATION: CreaturePresentation = {
  samples: SCENE_SAMPLES,
  expression: "rest",
  reducedMotion: false,
};

export interface CreatureScene {
  readonly root: Container;
  readonly body: CreatureMesh;
  activeAttractors(): readonly Graphics[];
  tick(dtSeconds: number): void;
  setVisualState(state: StageVisualState): void;
  setPresentation(presentation: CreaturePresentation): void;
  readPoseSummary(): PoseRenderSummary;
  layout(width: number, height: number): void;
  destroy(): void;
}

export function createCreatureScene(onBufferUpdate: () => void): CreatureScene {
  const sim: PoseSimulation = createPoseSimulation({
    clock: { nowMs: () => 0 },
    random: { next: () => 0.5 },
  });
  let snapshot: PoseSnapshot = sim.snapshot(SCENE_SAMPLES);
  let normalized = normalizeAttractions(SCENE_SAMPLES);
  let samples: readonly AttractionSample[] = SCENE_SAMPLES;
  let expression: CreatureExpression = "rest";
  let reducedMotion = false;
  let adhesionProgress = 0;
  let elapsedSeconds = 0;
  let orbit = 0;
  let scale = 1;
  let stageWidth = 0;
  let stageHeight = 0;

  const root = new Container();
  const shadow = new Graphics()
    .ellipse(0, 1.18, 0.95, 0.22)
    .fill({ color: CREATURE_COLORS.shadow, alpha: 0.2 });
  const layer = createAttractorLayer();
  const body = createCreatureMesh(snapshot, scale);
  const highlight = new Graphics()
    .ellipse(-0.3, -0.36, 0.42, 0.26)
    .fill({ color: CREATURE_COLORS.highlight, alpha: 0.7 });
  const effects = createCreatureEffects();
  const face = createCreatureFace();
  const ring = (color: number, alpha: number, width: number): Graphics => {
    const g = new Graphics().circle(0, 0, 1.55).stroke({ color, alpha, width });
    g.visible = false;
    return g;
  };
  const focusRing = ring(FOCUS_COLOR, 0.9, 0.06);
  const pendingRing = ring(CREATURE_COLORS.ink, 0.45, 0.05);
  const errorRing = ring(DANGER_COLOR, 0.9, 0.07);
  const scaledNodes = [
    shadow,
    highlight,
    focusRing,
    pendingRing,
    errorRing,
    effects.root,
    face.root,
  ];
  root.addChild(shadow, layer.root, body.view, highlight, effects.root, face.root);
  root.addChild(focusRing, pendingRing, errorRing);
  const actor = createActorRig({ body, shadow, highlight, face, effects, layer }, snapshot);
  const frame = (): ActorFrame => ({
    snapshot,
    normalized,
    expression,
    reducedMotion,
    elapsedSeconds,
    adhesionProgress,
    adhereMax: ADHERE_MAX,
    orbit,
    scale,
    stageWidth,
    stageHeight,
  });
  const updateScene = (): void => {
    body.update(snapshot, scale, actor.visual.centroid);
    onBufferUpdate();
    actor.sync(frame());
  };

  let visualState: StageVisualState = "normal";

  const layout = (width: number, height: number): void => {
    scale = Math.max(MIN_SCALE, Math.min(width, height) * SCALE_RATIO);
    stageWidth = width;
    stageHeight = height;
    root.position.set(width / 2, height / 2);
    for (const node of scaledNodes) node.scale.set(scale);
    layer.layout(width, height, scale);
    orbit = layer.orbit;
    updateScene();
  };

  const setPresentation = (presentation: CreaturePresentation): void => {
    // Validate the full sample set before mutating any presentation state.
    const next = normalizeAttractions(presentation.samples);
    const prevDominant = strongestIndex(normalized);
    const nextDominant = strongestIndex(next);
    const dominantChanged = nextDominant !== prevDominant;
    const unchangedSamples = sameNormalizedSamples(normalized, next);
    const expressionChanged = expression !== presentation.expression;
    const reducedChanged = reducedMotion !== presentation.reducedMotion;
    const enteredAdhering = expressionChanged && presentation.expression === "adhering";
    normalized = next;
    samples = presentation.samples;
    expression = presentation.expression;
    reducedMotion = presentation.reducedMotion;
    if (expression !== "adhering" || dominantChanged) adhesionProgress = 0;
    if (reducedMotion && expression === "adhering") adhesionProgress = ADHERE_MAX;
    // Refresh field metadata so readPoseSummary() is consistent; advance(0)
    // only snaps under reduced motion — otherwise visuals keep their position.
    snapshot = sim.snapshot(samples);
    actor.advance(frame(), 0);
    updateScene();
    if (unchangedSamples && !expressionChanged && !reducedChanged) return;
    if (reducedMotion) {
      effects.update(0, true);
      return;
    }
    const direction = directionOf(next, nextDominant);
    actor.aimSurface(frame(), direction.x, direction.y);
    if (dominantChanged) {
      effects.trigger("recoil", direction);
    } else if (enteredAdhering) {
      effects.trigger("adhere", direction);
    } else if (!unchangedSamples || expressionChanged) {
      effects.trigger("anticipate", direction);
    }
  };

  const tick = (dtSeconds: number): void => {
    elapsedSeconds += dtSeconds;
    snapshot = sim.advanceBy(samples, dtSeconds);
    if (expression === "adhering")
      adhesionProgress = Math.min(ADHERE_MAX, adhesionProgress + dtSeconds / ADHERE_SECONDS);
    actor.advance(frame(), dtSeconds);
    updateScene();
    effects.update(dtSeconds, reducedMotion);
    if (visualState === "loading") pendingRing.rotation += dtSeconds * 2;
  };

  const readPoseSummary = (): PoseRenderSummary => ({
    dominantAngleRad: snapshot.dominantAngleRad,
    dominance: snapshot.dominance,
    centroid: { x: snapshot.centroid.x, y: snapshot.centroid.y },
    gaze: { x: snapshot.gaze.x, y: snapshot.gaze.y },
    visualCentroid: { x: actor.visual.centroid.x, y: actor.visual.centroid.y },
    actorCenter: { x: actor.center.x, y: actor.center.y },
    actorOffset: { x: actor.visual.offset.x, y: actor.visual.offset.y },
    expression,
    adhesionProgress,
    face: face.readSummary(),
    effectOrigin: { x: actor.surface.x * scale, y: actor.surface.y * scale },
    activeParticles: effects.activeParticles(),
    reducedMotion,
  });

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (root.parent) root.parent.removeChild(root);
    body.destroy();
    root.destroy({ children: true });
  };

  return {
    root,
    body,
    activeAttractors: () => layer.activeAttractors(),
    tick,
    setVisualState: (state: StageVisualState) => {
      visualState = state;
      focusRing.visible = state === "focus";
      // "hesitating" borrows the soft pending ring for the flicker; the
      // other expression-like states ("engaged", "bored") render as normal.
      pendingRing.visible = state === "loading" || state === "hesitating";
      errorRing.visible = state === "error";
      body.view.alpha = state === "loading" ? LOADING_BODY_ALPHA : BODY_ALPHA;
      layer.setEmphasis(state === "focus");
    },
    setPresentation,
    readPoseSummary,
    layout,
    destroy,
  };
}
