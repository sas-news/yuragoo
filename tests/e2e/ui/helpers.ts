// Task 27 e2e helpers: viewport/overflow probes, the axe runner with
// impact classification, a Tab-walker for keyboard-only journeys and the
// evidence writer. Lobby join utilities are re-exported from the Task 24
// helpers so the spec reads end-to-end.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { API, createRoom, joinPage } from "../lobby/helpers";

export { API, createRoom, joinPage };
// window.__localBridge's ambient declaration lives in tests/e2e/game/helpers.ts.

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
export const EVIDENCE_DIR = join(
  process.cwd(),
  ".omo/evidence/yuragoo-development",
  `${stamp}-t27`,
);
export const writeEvidence = (name: string, data: unknown): void => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, name),
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
  );
};

// A joined lobby page inside a fresh context at the given width.
export const seat = async (
  browser: Browser,
  contexts: BrowserContext[],
  roomId: string,
  secret: string,
  name: string,
  width: number,
): Promise<Page> => {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await joinPage(page, roomId, secret, name);
  return page;
};

// document-level horizontal overflow: false the moment anything exceeds
// the initial containing block on either element.
export const noHorizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth <= doc.clientWidth && document.body.scrollWidth <= doc.clientWidth;
  });

export interface AxeSummary {
  readonly route: string;
  readonly width: number;
  readonly seriousCritical: readonly string[];
  readonly minorModerate: readonly string[];
  readonly full: unknown;
}

// Elements whose rendered box reaches past the viewport's right edge —
// the self-diagnosing version of noHorizontalOverflow for failure tests.
export const overflowCulprits = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const edge = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > edge + 1) {
        const cls = String((el as HTMLElement).className).slice(0, 40);
        out.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)}`);
      }
    }
    return out.slice(0, 8);
  });

export const runAxe = async (page: Page, route: string, width: number): Promise<AxeSummary> => {
  const full = await new AxeBuilder({ page }).analyze();
  return {
    route,
    width,
    seriousCritical: full.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.length} node(s)`),
    minorModerate: full.violations
      .filter((v) => v.impact === "minor" || v.impact === "moderate")
      .map((v) => `${v.id}: ${v.nodes.length} node(s)`),
    full,
  };
};

// Press Tab until document.activeElement matches `selector` (or give up).
export const tabTo = async (page: Page, selector: string, maxTabs = 90): Promise<void> => {
  await page.waitForSelector(selector, { timeout: 20_000 });
  for (let i = 0; i < maxTabs; i += 1) {
    const hit = await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector);
    if (hit) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`tab never reached ${selector}`);
};

// Same Tab-walk, but matching on the focused element's text — for buttons
// identified by their Japanese label (:has-text is not valid inside
// Element.matches).
export const tabToText = async (page: Page, text: string, maxTabs = 90): Promise<void> => {
  await page.getByRole("button", { name: text }).first().waitFor({ timeout: 20_000 });
  for (let i = 0; i < maxTabs; i += 1) {
    const hit = await page.evaluate(
      (t) =>
        document.activeElement?.tagName === "BUTTON" &&
        document.activeElement.textContent?.includes(t) === true,
      text,
    );
    if (hit) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`tab never reached a control labelled ${text}`);
};

// The focus indicator must be painted: :focus-visible + a real outline.
export const focusIsVisible = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || !el.matches(":focus-visible")) return false;
    const style = getComputedStyle(el);
    return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
  });

// /play boot: start through the real setup card, then wait for the
// creature runtime so seat chips exist.
export const gotoPlay = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/play?${query}`);
  await page.waitForFunction(() => window.__localBridge !== undefined);
};

export const startMatch = async (page: Page): Promise<void> => {
  await page.getByTestId("start-button").click();
  await page.waitForFunction(() => window.__localBridge?.state()?.phase === "playing");
  await page.waitForFunction(() => (window.__localBridge?.layout() ?? null) !== null);
};

export const png = (page: Page, name: string) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: join(EVIDENCE_DIR, name) });
};

// true when document.activeElement sits inside the open [role="dialog"].
export const insideDialog = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));

// Run axe, push the run into `runs` and hard-fail on serious/critical.
export const expectAxe = async (
  page: Page,
  runs: AxeSummary[],
  route: string,
  width: number,
): Promise<void> => {
  const report = await runAxe(page, route, width);
  runs.push(report);
  if (report.seriousCritical.length > 0) {
    throw new Error(
      `axe serious/critical on ${route}@${width}: ${JSON.stringify(report.seriousCritical)}`,
    );
  }
};
