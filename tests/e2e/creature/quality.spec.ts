import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  diagnostics,
  evidenceDir,
  evidencePath,
  finitePose,
  frameStats,
  pose,
  sampleFrameIntervals,
  setPresentation,
  waitLab,
  writeEvidence,
} from "./quality-helpers";

test("quality: production-like frame budgets and ten lifecycle resets", async ({
  page,
  context,
}) => {
  test.setTimeout(260_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dev/creature");
  await waitLab(page);
  await setPresentation(page, [0.8, 0.1, 0.05, 0.05], "engaged");
  await sampleFrameIntervals(page, 2_000);

  const desktop4Intervals = await sampleFrameIntervals(page, 120_000);
  const desktop4 = frameStats(desktop4Intervals);
  await setPresentation(page, [0.4, 0.2, 0.15, 0.1, 0.1, 0.05], "engaged");
  const desktop6Intervals = await sampleFrameIntervals(page, 30_000);
  const desktop6 = frameStats(desktop6Intervals);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const cpu4xIntervals = await sampleFrameIntervals(page, 30_000);
  const cpu4x = frameStats(cpu4xIntervals);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  await page.goto("/dev/showcase");
  await page.waitForFunction(() => window.__YURAGOO_E2E__ !== undefined);
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
  for (let i = 0; i < 10; i += 1) {
    await page.getByTestId("toggle-mount").click();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.__YURAGOO_E2E__?.diagnostics().activeApplications))
      .toBe(0);
    await page.getByTestId("toggle-mount").click();
    await expect(page.locator("canvas")).toHaveCount(1);
  }
  await page.getByTestId("toggle-mount").click();
  await expect
    .poll(() => page.evaluate(() => window.__YURAGOO_E2E__?.diagnostics().activeApplications))
    .toBe(0);
  const resources = await page.evaluate(() => window.__YURAGOO_E2E__?.diagnostics() ?? null);
  const result = { desktop4, desktop6, cpu4x, resources };
  writeEvidence("task-6-happy.json", result);
  writeEvidence("task-6-frame-trace.json", {
    desktop4: desktop4Intervals,
    desktop6: desktop6Intervals,
    cpu4x: cpu4xIntervals,
  });

  expect(desktop4.count).toBeGreaterThan(6_000);
  expect(desktop4.p95Ms).toBeLessThanOrEqual(20);
  expect(desktop6.count).toBeGreaterThan(1_500);
  expect(desktop6.p95Ms).toBeLessThanOrEqual(20);
  expect(cpu4x.count).toBeGreaterThan(700);
  expect(cpu4x.p95Ms).toBeLessThanOrEqual(34);
  expect(resources?.createdApplications).toBe(resources?.destroyedApplications);
  expect(resources?.activeApplications).toBe(0);
  expect(resources?.activeTickers).toBe(0);
});

test("quality: visual states, responsive UI, hidden resume and reduced motion", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const videoDir = evidenceDir ?? testInfo.outputPath("quality-video");
  mkdirSync(videoDir, { recursive: true });
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const video = page.video();

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/dev/showcase");
    await page.waitForFunction(() => window.__YURAGOO_E2E__ !== undefined);
    await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
    for (const state of ["normal", "focus", "loading", "error"] as const) {
      await page.getByTestId(`state-${state}`).click();
      const path = evidencePath(`task-6-ui-${width}-${state}.png`);
      if (path) await page.screenshot({ path, fullPage: true });
    }
    await page.goto("/dev/creature");
    await waitLab(page);
    await setPresentation(page, [0.05, 0.8, 0.1, 0.05], "engaged", true);
    const reducedPath = evidencePath(`task-6-ui-${width}-reduced.png`);
    if (reducedPath) await page.screenshot({ path: reducedPath, fullPage: true });
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dev/creature");
  await waitLab(page);
  const stateInputs = [
    ["rest", [1, 1, 1, 1], "rest"],
    ["weak", [0.35, 0.25, 0.2, 0.2], "engaged"],
    ["split", [0.45, 0.45, 0.05, 0.05], "hesitating"],
    ["strong", [0.8, 0.1, 0.05, 0.05], "engaged"],
    ["reversal", [0.05, 0.8, 0.1, 0.05], "engaged"],
  ] as const;
  const statePoses: Record<string, unknown> = {};
  for (const [name, weights, expression] of stateInputs) {
    await setPresentation(page, weights, expression);
    await page.waitForTimeout(300);
    statePoses[name] = await pose(page);
    const path = evidencePath(`task-6-pose-${name}.png`);
    if (path) await page.getByTestId("creature-stage").screenshot({ path });
  }
  await setPresentation(page, [0.8, 0.1, 0.05, 0.05], "adhering");
  await expect
    .poll(async () => (await pose(page))?.adhesionProgress ?? 0)
    .toBeGreaterThanOrEqual(0.9);
  statePoses.final = await pose(page);
  const finalPath = evidencePath("task-6-pose-final.png");
  if (finalPath) await page.getByTestId("creature-stage").screenshot({ path: finalPath });

  const beforeHidden = (await diagnostics(page))?.positionBufferUpdates ?? 0;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(5_000);
  const afterHidden = (await diagnostics(page))?.positionBufferUpdates ?? 0;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await diagnostics(page))?.positionBufferUpdates ?? 0)
    .toBeGreaterThan(afterHidden);
  await setPresentation(page, [0.05, 0.8, 0.1, 0.05], "engaged", true);
  const resumed = await pose(page);
  expect(afterHidden - beforeHidden).toBeLessThanOrEqual(1);
  expect(finitePose(resumed)).toBe(true);
  expect(resumed?.activeParticles).toBe(0);
  statePoses.hidden = { beforeHidden, afterHidden, resumed };
  writeEvidence("task-6-visual-states.json", statePoses);

  await page.close();
  if (video) {
    const target = evidencePath("task-6-failure.webm");
    if (target) await video.saveAs(target);
  }
  await context.close();
});
