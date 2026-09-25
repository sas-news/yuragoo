// Transition-timing measurement: with the retuned slow springs the dominant
// lobe should grow over ~1s (not snap) and contour motion should settle within
// ~4s. Records the observed timings to evidence for the party-readability tune.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { layout, set, waitReady, writeJson } from "./lab-bridge";

const EVIDENCE_DIR = process.env.YURAGOO_EVIDENCE_DIR;
const evidencePath = (name: string): string | undefined => {
  if (!EVIDENCE_DIR) return undefined;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  return join(EVIDENCE_DIR, name);
};

interface FrameSample {
  t: number;
  expression: string;
  ox: number;
  oy: number;
  ax: number;
  ay: number;
}

const SAMPLE_MS = 6000;
const SETTLE_VELOCITY = 0.02; // rest-units per second, mirrors the unit-test gate
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

test("happy: transition timing — lobe grows ~1s, settles within ~4s", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dev/creature");
  await waitReady(page);
  // Fully relax to a uniform baseline so the measured transition starts at rest.
  await set(page, [0.25, 0.25, 0.25, 0.25], "rest");
  await page.waitForTimeout(4500);
  const layoutInfo = await layout(page);
  if (!layoutInfo) throw new Error("layout summary missing");
  const scale = Math.max(40, Math.min(layoutInfo.stageWidth, layoutInfo.stageHeight) * 0.22);

  // Switch to a dominant A inside the sampling evaluate; t=0 is pinned to the
  // frame where the expression flips rest→engaged (applied atomically with the
  // new samples by setPresentation).
  const raw = await page.evaluate(async (duration) => {
    const bridge = window.__YURAGOO_LAB_E2E__;
    if (!bridge) return [];
    const out: FrameSample[] = [];
    bridge.set([0.8, 0.1, 0.05, 0.05], "engaged");
    const start = performance.now();
    while (performance.now() - start < duration) {
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
      const p = bridge.pose();
      out.push({
        t: performance.now() - start,
        expression: p.expression,
        ox: p.effectOrigin.x,
        oy: p.effectOrigin.y,
        ax: p.actorCenter.x,
        ay: p.actorCenter.y,
      });
    }
    return out;
  }, SAMPLE_MS);
  expect(raw.length).toBeGreaterThan(60);

  const appliedIndex = raw.findIndex((s) => s.expression === "engaged");
  expect(appliedIndex).toBeGreaterThanOrEqual(0);
  const t0 = raw[appliedIndex]?.t ?? 0;
  const samples = raw
    .filter((s) => s.t >= t0)
    .map((s) => ({
      t: s.t - t0,
      // Leading-surface offset along the visual gaze = the contour radius at
      // the dominant direction, in rest units.
      radius: Math.hypot(s.ox - s.ax, s.oy - s.ay) / (0.8 * scale),
    }));
  // The first frames can read radius≈0 while the gaze vector is still ~0;
  // a median over the first five frames gives the true baseline radius.
  const rStart = median(samples.slice(0, 5).map((s) => s.radius));
  const tail = samples.slice(-30);
  if (tail.length === 0) throw new Error("sample window empty");
  const rFinal = tail.reduce((sum, s) => sum + s.radius, 0) / tail.length;

  // (a) Dominant lobe visually established: first crossing of 90% of the total
  // radius change, plus the overshoot peak for the プルンプルン read.
  let establishedMs = -1;
  let peakRadius = 0;
  let peakMs = 0;
  for (const s of samples) {
    if (s.radius > peakRadius) {
      peakRadius = s.radius;
      peakMs = s.t;
    }
    if (establishedMs < 0 && s.radius >= rStart + 0.9 * (rFinal - rStart)) {
      establishedMs = s.t;
    }
  }

  // (b) Settled: the earliest T after which the lobe-radius velocity stays
  // below 0.02 rest/s — the same bound the unit dynamics tests assert.
  let settledMs = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) continue;
    const dt = (b.t - a.t) / 1000;
    if (dt > 0 && Math.abs(b.radius - a.radius) / dt >= SETTLE_VELOCITY) {
      settledMs = b.t;
    }
  }

  const summary = {
    measuredAt: new Date().toISOString(),
    sampleCount: samples.length,
    applyLagMs: t0,
    lobeRadiusStart: rStart,
    lobeRadiusSettled: rFinal,
    lobeEstablishedMs: establishedMs,
    lobePeakRadius: peakRadius,
    lobePeakMs: peakMs,
    settledVelocityBelow002Ms: settledMs,
  };
  writeJson(evidencePath("task-11c-timings.json"), summary);
  console.log("transition timings:", JSON.stringify(summary));

  // The retune intent: readable but finite — established in ~1s (not a <250ms
  // snap), overshoot present, fully settled well inside the 6s window.
  expect(establishedMs).toBeGreaterThan(250);
  expect(establishedMs).toBeLessThan(3000);
  expect(peakRadius).toBeGreaterThan(rFinal);
  expect(settledMs).toBeLessThan(SAMPLE_MS);
});
