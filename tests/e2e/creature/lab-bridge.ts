import { writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

export interface RectSummary {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSummary {
  stageWidth: number;
  stageHeight: number;
  bodyBounds: RectSummary;
  attractorCenters: { x: number; y: number }[];
  attractorBounds: RectSummary[];
}

export interface PoseSummary {
  dominantAngleRad: number | null;
  dominance: number;
  centroid: { x: number; y: number };
  gaze: { x: number; y: number };
  visualCentroid: { x: number; y: number };
  actorCenter: { x: number; y: number };
  actorOffset: { x: number; y: number };
  expression: string;
  adhesionProgress: number;
  face: {
    x: number;
    y: number;
    gazeX: number;
    gazeY: number;
    eyeOpen: number;
    lidTopY: number;
    lidBottomY: number;
  };
  effectOrigin: { x: number; y: number };
  activeParticles: number;
  reducedMotion: boolean;
}

export interface Diagnostics {
  createdApplications: number;
  destroyedApplications: number;
  activeApplications: number;
  activeTickers: number;
  positionBufferUpdates: number;
}

export interface TimelineSample {
  t: number;
  dominantAngleRad: number | null;
  adhesionProgress: number;
  actorCenter: { x: number; y: number };
  actorOffset: { x: number; y: number };
  visualCentroid: { x: number; y: number };
  face: { x: number; y: number };
  effectOrigin: { x: number; y: number };
}

declare global {
  interface Window {
    __YURAGOO_LAB_E2E__?: {
      set(weights: readonly number[], expression: string, reducedMotion?: boolean): void;
      pose(): PoseSummary;
      layout(): LayoutSummary;
      diagnostics(): Diagnostics;
    };
  }
}

export const pose = (page: Page): Promise<PoseSummary | null> =>
  page.evaluate(() => window.__YURAGOO_LAB_E2E__?.pose() ?? null);
export const set = (page: Page, w: readonly number[], e: string, r?: boolean) =>
  page.evaluate(({ w, e, r }) => window.__YURAGOO_LAB_E2E__?.set(w, e, r), { w, e, r });
export const diagnostics = (page: Page): Promise<Diagnostics | null> =>
  page.evaluate(() => window.__YURAGOO_LAB_E2E__?.diagnostics() ?? null);
export const layout = (page: Page): Promise<LayoutSummary | null> =>
  page.evaluate(() => window.__YURAGOO_LAB_E2E__?.layout() ?? null);
export const waitReady = async (page: Page) => {
  await page.waitForFunction(() => window.__YURAGOO_LAB_E2E__ !== undefined);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
};
export const angleNear = (angle: number | null | undefined, target: number): boolean =>
  typeof angle === "number" &&
  Math.abs(Math.atan2(Math.sin(angle - target), Math.cos(angle - target))) < 0.3;
export const dominantIs = (page: Page, target: number) =>
  expect.poll(async () => angleNear((await pose(page))?.dominantAngleRad, target)).toBe(true);
export const dominanceIs = (page: Page, target: number) =>
  expect.poll(async () => (await pose(page))?.dominance ?? -1).toBeCloseTo(target, 2);
export const expressionIs = (page: Page, expression: string) =>
  expect.poll(async () => (await pose(page))?.expression).toBe(expression);
export const activeParticles = (page: Page) =>
  expect.poll(async () => (await pose(page))?.activeParticles ?? -1);
export const pollPose = (page: Page, ok: (p: PoseSummary) => boolean) =>
  expect
    .poll(
      async () => {
        const p = await pose(page);
        return p !== null && ok(p);
      },
      { timeout: 100, intervals: [10, 20, 40, 80] },
    )
    .toBe(true);
export const adheringAt = (p: PoseSummary, angle: number) =>
  angleNear(p.dominantAngleRad, angle) && p.adhesionProgress === 0.92 && p.activeParticles === 0;

export interface PoseRecord {
  at: string;
  case: string;
  pose: PoseSummary;
}
const recorded: PoseRecord[] = [];
export const record = async (page: Page, name: string): Promise<PoseSummary | null> => {
  const p = await pose(page);
  if (p) recorded.push({ at: new Date().toISOString(), case: name, pose: p });
  return p;
};
export const writePoseLog = (target: string | undefined): void => {
  if (target) writeFileSync(target, `${JSON.stringify(recorded, null, 2)}\n`);
};
export const writeJson = (target: string | undefined, data: unknown): void => {
  if (target) writeFileSync(target, JSON.stringify(data, null, 2));
};

// Polls until a blink is observed (eyeOpen<0.5) and grabs a screenshot mid-blink.
export const waitForBlink = async (page: Page, pngPath?: string): Promise<PoseSummary | null> => {
  let blink: PoseSummary | null = null;
  const deadline = Date.now() + 6000;
  while (blink === null && Date.now() < deadline) {
    const p = await pose(page);
    if (p && p.face.eyeOpen < 0.5) {
      blink = p;
      if (pngPath) await page.screenshot({ path: pngPath });
    } else {
      await page.waitForTimeout(40);
    }
  }
  return blink;
};

export const expectBodyInsideStage = async (page: Page): Promise<void> => {
  const l = await layout(page);
  if (!l) throw new Error("layout summary missing");
  const b = l.bodyBounds;
  expect(b.x).toBeGreaterThanOrEqual(7.5);
  expect(b.y).toBeGreaterThanOrEqual(7.5);
  expect(b.x + b.width).toBeLessThanOrEqual(l.stageWidth - 7.5);
  expect(b.y + b.height).toBeLessThanOrEqual(l.stageHeight - 7.5);
};

export const expectCanvasInsideStage = async (page: Page): Promise<void> => {
  const canvasBox = await page.locator("canvas").boundingBox();
  const stageBox = await page.getByTestId("creature-stage").boundingBox();
  if (!canvasBox || !stageBox) throw new Error("canvas or stage bounds missing");
  expect(canvasBox.x).toBeGreaterThanOrEqual(stageBox.x - 0.5);
  expect(canvasBox.y).toBeGreaterThanOrEqual(stageBox.y - 0.5);
  expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 0.5);
  expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 0.5);
};

// Particles must spawn on the leading body surface: the origin sits along the
// visual gaze at roughly one contour radius from the actor center, on-stage.
export const expectSurfaceOrigin = async (page: Page, p: PoseSummary | null): Promise<void> => {
  if (!p) throw new Error("pose missing");
  const l = await layout(page);
  if (!l) throw new Error("layout summary missing");
  const scale = Math.max(40, Math.min(l.stageWidth, l.stageHeight) * 0.22);
  const dx = p.effectOrigin.x - p.actorCenter.x;
  const dy = p.effectOrigin.y - p.actorCenter.y;
  const distance = Math.hypot(dx, dy);
  const gazeLength = Math.hypot(p.face.gazeX, p.face.gazeY);
  const dot =
    distance > 1e-9 && gazeLength > 1e-9
      ? (dx * p.face.gazeX + dy * p.face.gazeY) / (distance * gazeLength)
      : 0;
  expect(dot).toBeGreaterThan(0.8);
  expect(distance).toBeGreaterThanOrEqual(0.45 * scale);
  expect(distance).toBeLessThanOrEqual(1.5 * scale);
  expect(Math.abs(p.effectOrigin.x)).toBeLessThanOrEqual(l.stageWidth / 2);
  expect(Math.abs(p.effectOrigin.y)).toBeLessThanOrEqual(l.stageHeight / 2);
};

export const sampleTimeline = (page: Page, ms: number): Promise<TimelineSample[]> =>
  page.evaluate(async (duration) => {
    const bridge = window.__YURAGOO_LAB_E2E__;
    const out: TimelineSample[] = [];
    if (!bridge) return out;
    const start = performance.now();
    while (performance.now() - start < duration) {
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
      const p = bridge.pose();
      out.push({
        t: performance.now() - start,
        dominantAngleRad: p.dominantAngleRad,
        adhesionProgress: p.adhesionProgress,
        actorCenter: { ...p.actorCenter },
        actorOffset: { ...p.actorOffset },
        visualCentroid: { ...p.visualCentroid },
        face: { x: p.face.x, y: p.face.y },
        effectOrigin: { ...p.effectOrigin },
      });
    }
    return out;
  }, ms);

// Reversal continuity: the first summary after a dominant switch must not
// teleport (<=8px), and per-frame actor travel stays bounded while the spring
// carries the body across the stage. Returns the max adjacent step for logs.
export const assertContinuous = (
  adhering: PoseSummary,
  immediate: PoseSummary | null,
  timeline: TimelineSample[],
): number => {
  const jump = Math.hypot(
    (immediate?.actorCenter.x ?? 9e9) - adhering.actorCenter.x,
    (immediate?.actorCenter.y ?? 0) - adhering.actorCenter.y,
  );
  expect(jump).toBeLessThanOrEqual(8);
  // Recoil particles spawn immediately on the new leading surface (right side).
  expect(immediate?.activeParticles ?? 0).toBeGreaterThan(0);
  expect(immediate?.effectOrigin.x ?? -1).toBeGreaterThan(0);
  let maxStep = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    const a = timeline[i - 1];
    const b = timeline[i];
    if (!a || !b) throw new Error("timeline gap");
    expect(Number.isFinite(b.actorCenter.x)).toBe(true);
    expect(Number.isFinite(b.actorCenter.y)).toBe(true);
    maxStep = Math.max(
      maxStep,
      Math.hypot(b.actorCenter.x - a.actorCenter.x, b.actorCenter.y - a.actorCenter.y),
    );
  }
  expect(maxStep).toBeLessThanOrEqual(12);
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  expect(last?.actorCenter.x ?? -9e9).toBeGreaterThan(first?.actorCenter.x ?? 9e9);
  expect(last?.adhesionProgress).toBe(0);
  return maxStep;
};
