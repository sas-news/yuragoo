import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { Diagnostics, PoseSummary } from "./lab-bridge";

export const evidenceDir = process.env.YURAGOO_EVIDENCE_DIR;

export function evidencePath(name: string): string | undefined {
  if (!evidenceDir) return undefined;
  mkdirSync(evidenceDir, { recursive: true });
  return join(evidenceDir, name);
}

export function writeEvidence(name: string, value: unknown): void {
  const path = evidencePath(name);
  if (path) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function waitLab(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__YURAGOO_LAB_E2E__ !== undefined);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
}

export const pose = (page: Page): Promise<PoseSummary | null> =>
  page.evaluate(() => window.__YURAGOO_LAB_E2E__?.pose() ?? null);

export const diagnostics = (page: Page): Promise<Diagnostics | null> =>
  page.evaluate(() => window.__YURAGOO_LAB_E2E__?.diagnostics() ?? null);

export const setPresentation = (
  page: Page,
  weights: readonly number[],
  expression: string,
  reducedMotion = false,
) =>
  page.evaluate(
    ({ nextWeights, nextExpression, reduced }) =>
      window.__YURAGOO_LAB_E2E__?.set(nextWeights, nextExpression, reduced),
    { nextWeights: weights, nextExpression: expression, reduced: reducedMotion },
  );

export async function sampleFrameIntervals(page: Page, durationMs: number): Promise<number[]> {
  return page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const intervals: number[] = [];
        const started = performance.now();
        let previous: number | null = null;
        const frame = (now: number): void => {
          if (previous !== null) intervals.push(now - previous);
          previous = now;
          if (now - started >= duration) resolve(intervals);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    durationMs,
  );
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("frame sample is empty");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

export function frameStats(values: readonly number[]) {
  return {
    count: values.length,
    p95Ms: percentile95(values),
    maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

export const finitePose = (value: PoseSummary | null): boolean =>
  value !== null &&
  (value.dominantAngleRad === null || Number.isFinite(value.dominantAngleRad)) &&
  [
    value.dominance,
    value.centroid.x,
    value.centroid.y,
    value.gaze.x,
    value.gaze.y,
    value.adhesionProgress,
    ...Object.values(value.face),
    value.effectOrigin.x,
    value.effectOrigin.y,
    value.activeParticles,
  ].every(Number.isFinite);
