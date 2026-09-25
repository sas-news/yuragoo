import { Application, type Ticker } from "pixi.js";
import type { AttractionSample, Vec2 } from "../attraction";
import { extractFrameBlob } from "../extract";
import { FIXED_STEP_SECONDS, MAX_SUBSTEPS } from "../spring";
import { CREATURE_COLORS } from "./materials";
import { createCreatureScene } from "./scene";

// Expression states carry no stage chrome except "hesitating": pending ring flash.
export type StageExpression = "hesitating" | "engaged" | "bored";
export type StageVisualState = "normal" | "focus" | "loading" | "error" | StageExpression;
export type CreatureExpression = "rest" | "hesitating" | "engaged" | "bored" | "adhering";
export interface CreaturePresentation {
  readonly samples: readonly AttractionSample[];
  readonly expression: CreatureExpression;
  readonly reducedMotion: boolean;
}

// Summary payloads for diagnostics and harnesses — plain JSON-able data.
export interface FaceSummary {
  readonly x: number;
  readonly y: number;
  readonly gazeX: number;
  readonly gazeY: number;
  readonly eyeOpen: number;
  readonly lidTopY: number;
  readonly lidBottomY: number;
}

export interface PoseRenderSummary {
  readonly dominantAngleRad: number | null;
  readonly dominance: number;
  readonly centroid: Vec2;
  readonly gaze: Vec2;
  readonly visualCentroid: Vec2;
  readonly actorCenter: Vec2;
  readonly actorOffset: Vec2;
  readonly expression: CreatureExpression;
  readonly adhesionProgress: number;
  readonly face: FaceSummary;
  readonly effectOrigin: Vec2;
  readonly activeParticles: number;
  readonly reducedMotion: boolean;
}
export interface RendererDiagnostics {
  readonly createdApplications: number;
  readonly destroyedApplications: number;
  readonly activeApplications: number;
  readonly activeTickers: number;
  readonly positionBufferUpdates: number;
}

export interface MountCreatureOptions {
  readonly signal: AbortSignal;
  readonly visualState: StageVisualState;
  readonly initializationDelayMs?: number;
  readonly forceUnsupported?: boolean;
  readonly backgroundAlpha?: number; // 0 = transparent canvas (default 1)
}
export interface BodySummary {
  readonly width: number;
  readonly height: number;
  readonly nonTransparentPixels: number;
  readonly alphaLevels: number;
}
export interface RectSummary {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface SceneLayoutSummary {
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly bodyBounds: RectSummary;
  readonly attractorCenters: readonly Vec2[];
  readonly attractorBounds: readonly RectSummary[];
}

export interface CreatureRuntime {
  setVisualState(state: StageVisualState): void;
  setPresentation(presentation: CreaturePresentation): void;
  extractBodySummary(): BodySummary;
  readLayoutSummary(): SceneLayoutSummary;
  readPoseSummary(): PoseRenderSummary;
  // One rendered frame as a PNG Blob for story panels; null when destroyed/unencodable.
  extractImage(): Promise<Blob | null>;
  destroy(): void;
}

// Runtime reachability for page-level harnesses (the e2e creature lab): the
// runtime rides on its canvas element — element-scoped, GC'd with it.
export interface CreatureCanvasHandle extends HTMLCanvasElement {
  __yuragooCreatureRuntime?: CreatureRuntime;
}
export class RendererUnsupportedError extends Error {
  constructor(cause?: unknown) {
    super("WebGL renderer is not supported", { cause });
    this.name = "RendererUnsupportedError";
  }
}

const counters = { created: 0, destroyed: 0, tickers: 0, bufferUpdates: 0 };
const MAX_FRAME_SECONDS = MAX_SUBSTEPS * FIXED_STEP_SECONDS;

export function readRendererDiagnostics(): RendererDiagnostics {
  return {
    createdApplications: counters.created,
    destroyedApplications: counters.destroyed,
    activeApplications: counters.created - counters.destroyed,
    activeTickers: counters.tickers,
    positionBufferUpdates: counters.bufferUpdates,
  };
}

export function resetRendererDiagnostics(): void {
  Object.assign(counters, { created: 0, destroyed: 0, tickers: 0, bufferUpdates: 0 });
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    // Once + settle-once semantics keep this leak-free without cleanup.
    signal.addEventListener("abort", () => reject(new Error("mount aborted")), { once: true });
    setTimeout(resolve, ms);
  });

export async function mountCreatureScene(
  host: HTMLElement,
  options: MountCreatureOptions,
): Promise<CreatureRuntime> {
  if (options.forceUnsupported === true) throw new RendererUnsupportedError();
  options.signal.throwIfAborted();
  const app = new Application();
  counters.created += 1;
  let appDestroyed = false;
  const destroyApp = (): void => {
    if (appDestroyed) return;
    appDestroyed = true;
    try {
      app.destroy({ removeView: true });
    } finally {
      counters.destroyed += 1;
    }
  };
  try {
    try {
      // Premultiplied canvases can paint an [r,g,b,0] clear opaque — clear black instead.
      const alpha = options.backgroundAlpha ?? 1;
      await app.init({
        preference: "webgl",
        antialias: true,
        backgroundColor: alpha < 1 ? 0x000000 : CREATURE_COLORS.paper,
        backgroundAlpha: alpha,
        autoDensity: true,
        resolution: Math.min(devicePixelRatio, 2),
        resizeTo: host,
        autoStart: false,
      });
    } catch (cause) {
      throw new RendererUnsupportedError(cause);
    }
    const delayMs = options.initializationDelayMs;
    if (delayMs !== undefined && delayMs > 0) await wait(delayMs, options.signal);
    options.signal.throwIfAborted();

    const scene = createCreatureScene(() => (counters.bufferUpdates += 1));
    app.stage.addChild(scene.root);
    scene.layout(app.screen.width, app.screen.height);
    scene.setVisualState(options.visualState);
    const canvas = app.canvas as CreatureCanvasHandle;
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);
    let lastWidth = app.screen.width,
      lastHeight = app.screen.height;
    const onTick = (ticker: Ticker): void => {
      const { width, height } = app.screen;
      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width;
        lastHeight = height;
        scene.layout(width, height);
      }
      scene.tick(Math.min(ticker.deltaMS / 1000, MAX_FRAME_SECONDS));
    };
    app.ticker.add(onTick);
    const syncVisibility = (): void =>
      void (document.hidden ? app.ticker.stop() : app.ticker.start());
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    counters.tickers += 1;

    let runtimeDestroyed = false;
    const runtime: CreatureRuntime = {
      setVisualState: (state: StageVisualState) => scene.setVisualState(state),
      setPresentation: (presentation: CreaturePresentation) => scene.setPresentation(presentation),
      readPoseSummary: () => scene.readPoseSummary(),
      extractImage: () => (runtimeDestroyed ? Promise.resolve(null) : extractFrameBlob(app)),
      extractBodySummary: () => {
        app.render();
        const bodyMesh = scene.body.view;
        // no-batch geometries only rasterize when the stage is the extract target;
        // the frame restricts the readback to the body's screen-space bounds.
        const out = app.renderer.extract.pixels({
          target: app.stage,
          frame: bodyMesh.getBounds().rectangle,
        });
        let nonTransparentPixels = 0;
        const levels = new Set<number>();
        for (let i = 3; i < out.pixels.length; i += 4) {
          const alpha = out.pixels[i] ?? 0;
          if (alpha > 0) {
            nonTransparentPixels += 1;
            levels.add(alpha);
          }
        }
        return {
          width: out.width,
          height: out.height,
          nonTransparentPixels,
          alphaLevels: levels.size,
        };
      },
      readLayoutSummary: () => {
        app.render();
        return {
          stageWidth: app.screen.width,
          stageHeight: app.screen.height,
          bodyBounds: { ...scene.body.view.getBounds().rectangle },
          attractorCenters: scene.activeAttractors().map((a) => ({ ...a.getGlobalPosition() })),
          attractorBounds: scene.activeAttractors().map((a) => ({ ...a.getBounds().rectangle })),
        };
      },
      destroy: () => {
        if (runtimeDestroyed) return;
        runtimeDestroyed = true;
        document.removeEventListener("visibilitychange", syncVisibility);
        app.ticker.remove(onTick);
        app.ticker.stop();
        counters.tickers -= 1;
        scene.destroy();
        canvas.remove();
        destroyApp();
      },
    };
    canvas.__yuragooCreatureRuntime = runtime;
    return runtime;
  } catch (error) {
    destroyApp();
    throw error;
  }
}
