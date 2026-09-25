import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

interface Diagnostics {
  createdApplications: number;
  destroyedApplications: number;
  activeApplications: number;
  activeTickers: number;
  positionBufferUpdates: number;
}
interface BodySummary {
  width: number;
  height: number;
  nonTransparentPixels: number;
  alphaLevels: number;
}
interface LayoutSummary {
  stageWidth: number;
  stageHeight: number;
  bodyBounds: { x: number; y: number; width: number; height: number };
  attractorCenters: { x: number; y: number }[];
  attractorBounds: { x: number; y: number; width: number; height: number }[];
}
declare global {
  interface Window {
    __YURAGOO_E2E__?: {
      diagnostics(): Diagnostics;
      extractBodySummary(): BodySummary;
      readLayoutSummary(): LayoutSummary;
    };
  }
}

const EVIDENCE_DIR = process.env.YURAGOO_EVIDENCE_DIR;
const evidencePath = (name: string): string | undefined => {
  if (!EVIDENCE_DIR) return undefined;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  return join(EVIDENCE_DIR, name);
};
const diagnostics = (page: Page): Promise<Diagnostics | null> =>
  page.evaluate(() => window.__YURAGOO_E2E__?.diagnostics() ?? null);
const bodySummary = (page: Page): Promise<BodySummary | null> =>
  page.evaluate(() => window.__YURAGOO_E2E__?.extractBodySummary() ?? null);
const layoutSummary = (page: Page): Promise<LayoutSummary | null> =>
  page.evaluate(() => window.__YURAGOO_E2E__?.readLayoutSummary() ?? null);
const stage = (page: Page) => page.getByTestId("creature-stage");
const waitReady = async (page: Page) => {
  await page.waitForFunction(() => window.__YURAGOO_E2E__ !== undefined);
  await expect(stage(page)).toHaveAttribute("data-status", "ready");
};
const renderCount = async (page: Page) =>
  Number(await page.getByTestId("render-count").getAttribute("data-count"));

test("happy: translucent creature canvas mounts across viewports and states", async ({
  page,
}, testInfo) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    // Given the showcase at this width, When it becomes ready
    await page.goto("/dev/showcase");
    await waitReady(page);
    // Then exactly one real canvas at >=280px height with a translucent rendered body
    await expect(page.locator("canvas")).toHaveCount(1);
    const canvasBox = await page.locator("canvas").boundingBox();
    const stageBox = await stage(page).boundingBox();
    expect(canvasBox && canvasBox.width > 0 && canvasBox.height >= 280).toBe(true);
    expect(stageBox?.height ?? 0).toBeGreaterThanOrEqual(280);
    const diag = await diagnostics(page);
    expect(diag?.activeApplications).toBe(1);
    expect(diag?.activeTickers).toBe(1);
    const summary = await bodySummary(page);
    expect(summary && summary.width > 0 && summary.height > 0).toBe(true);
    expect(summary?.nonTransparentPixels ?? 0).toBeGreaterThan(0);
    expect(summary?.alphaLevels ?? 0).toBeGreaterThanOrEqual(2);
    // And the layout puts one centered body apart from four cardinal attractors
    const layout = await layoutSummary(page);
    if (!layout) throw new Error("layout summary missing");
    const cx = layout.stageWidth / 2;
    const cy = layout.stageHeight / 2;
    const bb = layout.bodyBounds;
    expect(bb.width).toBeGreaterThanOrEqual(80);
    expect(bb.height).toBeGreaterThanOrEqual(80);
    expect(Math.abs(bb.x + bb.width / 2 - cx)).toBeLessThanOrEqual(0.2 * layout.stageWidth);
    expect(Math.abs(bb.y + bb.height / 2 - cy)).toBeLessThanOrEqual(0.2 * layout.stageHeight);
    const centers = layout.attractorCenters;
    expect(centers).toHaveLength(4);
    const sector = (p: { x: number; y: number }) =>
      Math.abs(p.x - cx) > Math.abs(p.y - cy) ? (p.x > cx ? "E" : "W") : p.y > cy ? "S" : "N";
    expect(new Set(centers.map(sector)).size).toBe(4);
    const minOrbit = Math.max(bb.width, bb.height) * 0.6;
    for (const [i, p] of centers.entries()) {
      const dist = Math.hypot(p.x - cx, p.y - cy);
      expect(dist).toBeGreaterThan(minOrbit);
      if (i === 0) {
        expect(p.y).toBeLessThan(cy);
        expect(Math.abs(p.x - cx)).toBeLessThan(0.25 * dist);
      }
      if (i === 1) expect(p.x).toBeGreaterThan(cx);
      if (i === 2) expect(p.y).toBeGreaterThan(cy);
      if (i === 3) expect(p.x).toBeLessThan(cx);
    }
    // And every attractor's full stroked ring stays inside the stage
    expect(layout.attractorBounds).toHaveLength(4);
    for (const b of layout.attractorBounds) {
      expect(b.x).toBeGreaterThanOrEqual(-0.5);
      expect(b.y).toBeGreaterThanOrEqual(-0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(layout.stageWidth + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(layout.stageHeight + 0.5);
    }
    if (width === 1280) {
      const target = evidencePath("task-4-happy.png");
      if (target) await page.screenshot({ path: target });
      else await testInfo.attach("task-4-happy", { body: await page.screenshot() });
    }
  }
  // When switching visual states, Then DOM semantics follow without remount
  for (const state of ["focus", "loading", "error", "normal"] as const) {
    await page.getByTestId(`state-${state}`).click();
    await expect(stage(page)).toHaveAttribute("data-state", state);
    if (state === "loading") await expect(stage(page)).toHaveAttribute("aria-busy", "true");
    if (state === "error") await expect(page.getByRole("alert").first()).toBeVisible();
  }
  await expect(page.locator("canvas")).toHaveCount(1);
  // And keyboard focus shows a visible focus ring on a control
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus-visible");
  await expect(focused).toHaveJSProperty("tagName", "BUTTON");
  const outlineWidth = await focused.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(outlineWidth).toBe("3px");
  // And buffer updates keep flowing while React does not re-render
  const before = (await diagnostics(page))?.positionBufferUpdates ?? 0;
  const renders = await renderCount(page);
  await expect
    .poll(async () => (await diagnostics(page))?.positionBufferUpdates ?? 0)
    .toBeGreaterThan(before);
  expect(await renderCount(page)).toBe(renders);
});

test("failure: repeated mount/unmount leaves exactly zero or one live app", async ({ page }) => {
  // Given a mounted showcase
  await page.goto("/dev/showcase");
  await waitReady(page);
  // When cycling mount/unmount 10 times, Then a single app/ticker lives or none
  for (let i = 0; i < 10; i++) {
    await page.getByTestId("toggle-mount").click();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect.poll(async () => (await diagnostics(page))?.activeApplications).toBe(0);
    await page.getByTestId("toggle-mount").click();
    await expect(page.locator("canvas")).toHaveCount(1);
    await expect(stage(page)).toHaveAttribute("data-status", "ready");
    const diag = await diagnostics(page);
    expect(diag?.activeApplications).toBe(1);
    expect(diag?.activeTickers).toBe(1);
  }
  // And a final unmount balances creation with destruction, then remount works
  await page.getByTestId("toggle-mount").click();
  await expect.poll(async () => (await diagnostics(page))?.activeApplications).toBe(0);
  const settled = await diagnostics(page);
  expect(settled?.createdApplications).toBe(settled?.destroyedApplications);
  expect(settled?.activeTickers).toBe(0);
  await page.getByTestId("toggle-mount").click();
  await expect(page.locator("canvas")).toHaveCount(1);
  const target = evidencePath("task-4-resources.json");
  const finalDiag = await diagnostics(page);
  if (target && finalDiag) writeFileSync(target, `${JSON.stringify(finalDiag, null, 2)}\n`);
});

test("failure: aborting during delayed init never attaches canvas or ticker", async ({ page }) => {
  // Given a mount with a 150ms init delay, When unmounted while initializing
  await page.goto("/dev/showcase?initDelay=150");
  await page.getByTestId("toggle-mount").click();
  // Then teardown settles: creation matches destruction with nothing active
  await expect
    .poll(async () => {
      const d = await diagnostics(page);
      return (
        d !== null &&
        d.activeApplications === 0 &&
        d.createdApplications === d.destroyedApplications
      );
    })
    .toBe(true);
  await expect(page.locator("canvas")).toHaveCount(0);
  const diag = await diagnostics(page);
  expect(diag?.activeApplications).toBe(0);
  expect(diag?.activeTickers).toBe(0);
  expect(diag?.createdApplications).toBe(diag?.destroyedApplications);
  // And a later remount still succeeds
  await page.getByTestId("toggle-mount").click();
  await waitReady(page);
  await expect(page.locator("canvas")).toHaveCount(1);
});

test("failure: unsupported WebGL shows a Japanese alert and no canvas", async ({ page }) => {
  // Given forceUnsupported, When the page loads
  await page.goto("/dev/showcase?forceUnsupported=1");
  // Then an alert explains the game cannot start and nothing renders
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("ゲームを開始できません");
  await expect(page.locator("canvas")).toHaveCount(0);
  const diag = await diagnostics(page);
  expect(diag?.activeApplications ?? 0).toBe(0);
  expect(diag?.activeTickers ?? 0).toBe(0);
  await expect(page.getByTestId("toggle-mount")).toBeVisible();
});
