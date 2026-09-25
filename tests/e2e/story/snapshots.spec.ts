// E2E for Task 30: the lab's real creature runtime captures a non-empty
// PNG through extractImage, canonical replay is bit-deterministic for the
// same pull, the replayed dominant direction matches the live stage, and
// the image cache trims at the panel cap. Blob bytes ferry page->Node
// base64 so capturePanelImage runs its real path in this process.
import { expect, test, type Page } from "@playwright/test";
import {
  canonicalPose,
  capturePanelImage,
  capturePose,
  clearCapturedPoses,
  MAX_PANEL_IMAGES,
  panelImage,
  poseForEvent,
  releaseAll,
  replaySamples,
  size,
} from "@yuragoo/creature";
import { set, waitReady } from "../creature/lab-bridge";

// The runtime is reachable on the lab canvas via the lifecycle expando.
interface RuntimeCanvas extends HTMLCanvasElement {
  __yuragooCreatureRuntime?: { extractImage(): Promise<Blob | null> };
}

// Read the canvas runtime's extractImage and ferry the PNG as base64 —
// Blob does not serialize across page.evaluate on its own.
const extractBase64 = (page: Page): Promise<string | null> =>
  page.evaluate(async () => {
    const canvas = document.querySelector<RuntimeCanvas>("canvas");
    const runtime = canvas?.__yuragooCreatureRuntime;
    if (!runtime) return null;
    const blob = await runtime.extractImage();
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `${blob.type}|${btoa(binary)}`;
  });

// A Node-side PanelImageSource whose pixels come from the live page: real
// renderer frames drive the real cache code end to end.
const pageSource = (page: Page) => ({
  extractImage: async (): Promise<Blob | null> => {
    const packed = await extractBase64(page);
    if (packed === null) return null;
    const sep = packed.indexOf("|");
    const type = packed.slice(0, sep);
    const bytes = Buffer.from(packed.slice(sep + 1), "base64");
    return new Blob([bytes], { type });
  },
});

const pull = [0.6, 0.25, 0.1, 0.05];

test("happy: a rendered frame extracts as a non-empty PNG blob", async ({ page }) => {
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, pull, "engaged");
  const packed = await extractBase64(page);
  expect(packed).not.toBeNull();
  const sep = packed?.indexOf("|") ?? -1;
  expect(packed?.slice(0, sep)).toBe("image/png");
  const bytes = Buffer.from(packed?.slice(sep + 1) ?? "", "base64");
  expect(bytes.length).toBeGreaterThan(0);
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A.
  expect(bytes[0]).toBe(0x89);
  expect(bytes.toString("latin1", 1, 4)).toBe("PNG");
  // A second capture after a pull change is another real, distinct frame.
  await set(page, [0.05, 0.8, 0.1, 0.05], "engaged");
  await page.waitForTimeout(250);
  const second = await extractBase64(page);
  expect(second).not.toBeNull();
  expect(second).not.toBe(packed);
});

test("happy: replay is deterministic and matches the live dominant lean", async ({ page }) => {
  await page.goto("/dev/creature");
  await waitReady(page);
  // Same pull -> identical samples and pose JSON on every evaluation.
  const samplesA = replaySamples(pull);
  const samplesB = replaySamples(pull);
  expect(JSON.stringify(samplesB)).toBe(JSON.stringify(samplesA));
  const poseA = canonicalPose(pull);
  const poseB = canonicalPose(pull);
  expect(JSON.stringify(poseB)).toBe(JSON.stringify(poseA));
  // The canonical dominant direction is slot 0's angle (-PI/2); the live
  // stage driving the same pull leans the same way once settled.
  // dominantAngleRad normalizes to [0,2PI) — compare on the circle.
  const angleDelta = (a: number | null, b: number): number =>
    a === null ? Math.PI * 2 : Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  expect(angleDelta(poseA.dominantAngleRad, -Math.PI / 2)).toBeLessThan(1e-9);
  await set(page, pull, "engaged");
  await page.waitForTimeout(4500); // spring settle window, matches replay
  const live = await page.evaluate(
    () => window.__YURAGOO_LAB_E2E__?.pose().dominantAngleRad ?? null,
  );
  expect(live).not.toBeNull();
  expect(angleDelta(live, poseA.dominantAngleRad ?? 0)).toBeLessThan(1e-6);
  // Null pull stays uniform at rest, distinct from any leaned pose.
  expect(replaySamples(null).every((s) => s.weight === 0.25)).toBe(true);
  // The eventId registry returns the memoized canonical capture.
  clearCapturedPoses();
  const captured = capturePose(7, pull);
  expect(poseForEvent(7)).toBe(captured);
  expect(JSON.stringify(captured.pose)).toBe(JSON.stringify(poseA));
  clearCapturedPoses();
});

test("happy: the image cache trims to the panel cap, evicting oldest first", async ({ page }) => {
  await page.goto("/dev/creature");
  await waitReady(page);
  await set(page, pull, "engaged");
  releaseAll();
  const source = pageSource(page);
  // Real renderer frames through the real cache: six events over the cap.
  const ids = [101, 102, 103, 104, 105, 106];
  for (const id of ids) {
    const blob = await capturePanelImage(source, id);
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe("image/png");
    expect(blob?.size ?? 0).toBeGreaterThan(0);
  }
  expect(size()).toBe(MAX_PANEL_IMAGES);
  expect(panelImage(101)).toBeNull();
  for (const id of ids.slice(1)) expect(panelImage(id)).not.toBeNull();
  // A cached hit is memoized — extractImage is not re-run.
  const hit = panelImage(106);
  expect(await capturePanelImage(source, 106)).toBe(hit);
  releaseAll();
  expect(size()).toBe(0);
});
