import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  activeParticles,
  adheringAt,
  angleNear,
  assertContinuous,
  diagnostics,
  dominantIs,
  dominanceIs,
  expectBodyInsideStage,
  expectCanvasInsideStage,
  expectSurfaceOrigin,
  expressionIs,
  pollPose,
  pose,
  record,
  sampleTimeline,
  set,
  waitForBlink,
  waitReady,
  writeJson,
  writePoseLog,
} from "./lab-bridge";

test.use({ video: "on" });

const EVIDENCE_DIR = process.env.YURAGOO_EVIDENCE_DIR;
const evidencePath = (name: string): string | undefined => {
  if (!EVIDENCE_DIR) return undefined;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  return join(EVIDENCE_DIR, name);
};

test.afterAll(() => writePoseLog(evidencePath("task-5-poses.json")));

test("happy: A→B reversal drives dominant angle, gaze and face", async ({ page }) => {
  const video = page.video();
  // Given the lab with 4 choices, When A becomes dominant and engaged
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, [0.8, 0.1, 0.05, 0.05], "engaged");
  await dominantIs(page, -Math.PI / 2);
  await dominanceIs(page, 0.7);
  // Visual gaze springs to the new target — wait for the slower spring to converge
  await expect
    .poll(async () => (await pose(page))?.face.gazeY ?? 0, { timeout: 8000 })
    .toBeLessThan(-0.8);
  const poseA = await record(page, "A-engaged");
  expect(poseA?.gaze.y ?? 0).toBeLessThan(-0.8);
  const updatesBefore = (await diagnostics(page))?.positionBufferUpdates ?? 0;
  // When B takes over, Then dominant/gaze/face swing right and the buffer keeps streaming
  await set(page, [0.05, 0.8, 0.1, 0.05], "engaged");
  await dominantIs(page, 0);
  await dominanceIs(page, 0.7);
  await expect
    .poll(async () => (await pose(page))?.face.gazeX ?? 0, { timeout: 8000 })
    .toBeGreaterThan(0.8);
  const poseB = await record(page, "B-engaged");
  expect(poseB?.gaze.x ?? 0).toBeGreaterThan(0.8);
  expect(poseB?.face.x).not.toBe(poseA?.face.x);
  const diag = await diagnostics(page);
  expect(diag?.activeApplications).toBe(1);
  expect(diag?.activeTickers).toBe(1);
  await expect
    .poll(async () => (await diagnostics(page))?.positionBufferUpdates ?? 0)
    .toBeGreaterThan(updatesBefore);
  // And a scripted adhesion-then-reversal plays out on the recorded video
  await page.getByTestId("script-adhere").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const status = page.getByTestId("script-status");
  await expect(status).toHaveAttribute("data-script-status", "running");
  await expect(status).toHaveAttribute("data-script-status", "complete", { timeout: 9000 });
  await record(page, "after-adhere-script");
  await page.close();
  const target = evidencePath("task-5-happy.webm");
  if (video && target) await video.saveAs(target);
});

test("happy: tie, uniform and 2/6 layouts stay finite and in-stage", async ({ page }) => {
  // Given a hesitating A/B tie, Then dominance collapses and gaze alternates between directions
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, [0.45, 0.45, 0.05, 0.05], "hesitating");
  await expressionIs(page, "hesitating");
  const tie = await record(page, "tie-hesitating");
  expect(tie?.expression).toBe("hesitating");
  expect(tie?.dominance ?? 1).toBeLessThan(0.05);
  // And the face alternates between the two tied slot directions (A top, B right)
  await expect
    .poll(async () => (await pose(page))?.face.gazeY ?? 0, { timeout: 8000 })
    .toBeLessThan(-0.8);
  await expect
    .poll(async () => (await pose(page))?.face.gazeX ?? 0, { timeout: 8000 })
    .toBeGreaterThan(0.8);
  // When weights go uniform, Then dominance and gaze settle to zero but stay finite
  await set(page, [1, 1, 1, 1], "rest");
  await expect.poll(async () => (await pose(page))?.dominance ?? 1).toBeLessThan(0.02);
  const uniform = await record(page, "uniform");
  expect(uniform?.dominance ?? 1).toBeLessThan(0.02);
  expect(Math.hypot(uniform?.gaze.x ?? 9, uniform?.gaze.y ?? 9)).toBeLessThan(0.05);
  expect(Number.isFinite(uniform?.centroid.x)).toBe(true);
  // And switching to 2 then 6 choices keeps one canvas fully inside the stage
  for (const n of [2, 6]) {
    await page.getByTestId(`count-${n}`).click();
    await expect(page.locator("[data-lab-slider]")).toHaveCount(n);
    await expect(page.locator("canvas")).toHaveCount(1);
  }
  await expectCanvasInsideStage(page);
});

test("happy: adhesion builds to its cap then reverses without teleport", async ({ page }) => {
  const video = page.video();
  // Given A engaged, When A starts adhering
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, [0.8, 0.1, 0.05, 0.05], "engaged");
  await dominantIs(page, -Math.PI / 2);
  const before = await pose(page);
  await set(page, [0.8, 0.1, 0.05, 0.05], "adhering");
  // Then progress climbs toward but never past the 0.92 cap and the face drifts toward A
  await expect
    .poll(async () => (await pose(page))?.adhesionProgress ?? 0, { timeout: 4000 })
    .toBeGreaterThanOrEqual(0.7);
  await activeParticles(page).toBeGreaterThan(0);
  const adhering = await record(page, "adhering-A");
  if (!adhering) throw new Error("pose missing");
  expect(adhering.adhesionProgress).toBeLessThanOrEqual(0.92);
  expect(adhering.face.y).toBeLessThan((before?.face.y ?? 0) - 5);
  await expectSurfaceOrigin(page, adhering);
  await expectBodyInsideStage(page);
  // When B takes over directly, Then the actor does not teleport and recoil
  // particles spawn on the new leading surface
  await set(page, [0.05, 0.8, 0.1, 0.05], "engaged");
  const immediate = await pose(page);
  // And over the next 700ms the actor travels continuously toward B
  const timeline = await sampleTimeline(page, 700);
  expect(timeline.length).toBeGreaterThan(5);
  const maxStep = assertContinuous(adhering, immediate, timeline);
  writeJson(evidencePath("feedback-timeline.json"), {
    recordedAt: new Date().toISOString(),
    maxStep,
    adhering,
    immediate,
    timeline,
  });
  await dominantIs(page, 0);
  const reversed = await record(page, "reversal-B");
  expect(reversed?.adhesionProgress).toBe(0);
  expect(reversed?.gaze.x ?? 0).toBeGreaterThan(0.8);
  await expectSurfaceOrigin(page, reversed);
  await page.close();
  const videoTarget = evidencePath("feedback-happy.webm");
  if (video && videoTarget) await video.saveAs(videoTarget);
});

test("happy: eyelids close from the top edge", async ({ page }) => {
  // Given an open eye, Then the lid span is essentially zero
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, [0.8, 0.1, 0.05, 0.05], "engaged");
  const open = await pose(page);
  expect((open?.face.lidBottomY ?? 1) - (open?.face.lidTopY ?? 0)).toBeLessThanOrEqual(0.01);
  // When bored (half open), Then the lid top stays anchored at the upper eye edge
  await set(page, [0.8, 0.1, 0.05, 0.05], "bored");
  const bored = await record(page, "bored-lid");
  expect(bored?.face.lidTopY).toBeCloseTo(-0.17 * 1.2, 3);
  expect(bored?.face.lidBottomY ?? -1).toBeGreaterThan(bored?.face.lidTopY ?? 0);
  const boredHeight = (bored?.face.lidBottomY ?? 0) - (bored?.face.lidTopY ?? 0);
  // And during a blink the descending lid covers more of the eye than bored
  await set(page, [0.8, 0.1, 0.05, 0.05], "engaged");
  const blink = await waitForBlink(page, evidencePath("feedback-lid.png"));
  expect(blink).not.toBeNull();
  expect((blink?.face.lidBottomY ?? 0) - (blink?.face.lidTopY ?? 0)).toBeGreaterThan(boredHeight);
});

test("failure: reduced motion kills particles and blink but keeps pose live", async ({
  page,
}, testInfo) => {
  // Given reduced motion is on, When A then B drive the creature
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, [0.8, 0.1, 0.05, 0.05], "engaged", true);
  await dominantIs(page, -Math.PI / 2);
  await set(page, [0.05, 0.8, 0.1, 0.05], "engaged", true);
  // Then the new pose applies within 100ms with zero particles and no blink wobble
  await pollPose(
    page,
    (p) =>
      angleNear(p.dominantAngleRad, 0) && p.dominance > 0.6 && p.gaze.x > 0.8 && p.face.gazeX > 0.8,
  );
  const reduced = await record(page, "reduced-B");
  expect(reduced?.reducedMotion).toBe(true);
  expect(reduced?.activeParticles).toBe(0);
  expect(reduced?.gaze.x ?? 0).toBeGreaterThan(0.8);
  const open = reduced?.face.eyeOpen;
  await page.waitForTimeout(320); // span a full 180ms blink window
  const later = await pose(page);
  expect(later?.face.eyeOpen).toBe(open);
  expect(later?.face.lidTopY).toBe(reduced?.face.lidTopY);
  // And reduced adhesion snaps to its static 0.92 posture per side instantly
  await set(page, [0.8, 0.1, 0.05, 0.05], "adhering", true);
  await pollPose(page, (p) => adheringAt(p, -Math.PI / 2) && p.effectOrigin.y < -10);
  await record(page, "reduced-adhering-A");
  await expectBodyInsideStage(page);
  await set(page, [0.05, 0.8, 0.1, 0.05], "adhering", true);
  await pollPose(page, (p) => adheringAt(p, 0) && p.face.x > 10 && p.effectOrigin.x > 10);
  await record(page, "reduced-adhering-B");
  await expectBodyInsideStage(page);
  await expect(page.locator("canvas")).toHaveCount(1);
  const target = evidencePath("task-5-failure.png");
  if (target) await page.screenshot({ path: target });
  else await testInfo.attach("task-5-failure", { body: await page.screenshot() });
});

test("failure: production bundle carries no lab or e2e bridge artifacts", () => {
  // Given a normal production build, Then lab and bridge literals never ship
  execSync("bun --cwd=apps/web run build", { stdio: "pipe" });
  const distDir = join(process.cwd(), "apps/web/dist");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const corpus = walk(distDir)
    .filter((file) => file.endsWith(".js") || file.endsWith(".html"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const markers = [
    "__YURAGOO_LAB_E2E__",
    "クリーチャーラボ",
    "/dev/creature",
    "data-lab-slider",
    "__YURAGOO_E2E__",
    "ゆらぐー！描画ショーケース",
    "/dev/showcase",
  ];
  const found = markers.filter((marker) => corpus.includes(marker));
  const target = evidencePath("task-5-prod-scan.txt");
  if (target) {
    writeFileSync(
      target,
      `markers scanned: ${markers.join(", ")}\nfound: ${found.length > 0 ? found.join(", ") : "none"}\n`,
    );
  }
  expect(found).toEqual([]);
});
