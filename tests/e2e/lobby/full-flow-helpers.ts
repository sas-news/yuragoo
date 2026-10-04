// Task 28 full-flow helpers (split from the spec for the size cap): real
// DOM-only user paths — home create, invite-link + name panel joins, host
// edits, ready/start and the TURN match loop driven through the real
// input dock. Waits are DOM/state probes only.
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { joinPage, waitChoiceLabelOn, waitReadyCount, waitScenarioOn } from "./helpers";

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
export const EVIDENCE_DIR = join(
  process.cwd(),
  ".omo/evidence/yuragoo-development",
  `${stamp}-t28`,
);
export const newPage = async (
  browser: Browser,
  contexts: BrowserContext[],
  permissions?: string[],
): Promise<Page> => {
  const ctx = await browser.newContext(permissions === undefined ? {} : { permissions });
  contexts.push(ctx);
  return ctx.newPage();
};

export const seat = async (
  browser: Browser,
  contexts: BrowserContext[],
  roomId: string,
  secret: string,
  name: string,
): Promise<Page> => {
  const page = await newPage(browser, contexts);
  await joinPage(page, roomId, secret, name);
  return page;
};

// Home -> 部屋を作る -> name panel -> host lobby. The clipboard permission
// lets the test pull the copied invite like a real user paste.
export const createViaHome = async (
  browser: Browser,
  contexts: BrowserContext[],
  apiQ: string,
  videoDir?: string,
): Promise<Page> => {
  const ctx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    ...(videoDir === undefined ? {} : { recordVideo: { dir: videoDir } }),
  });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(`/?${apiQ}`);
  await page.getByTestId("create-room").click();
  await page.waitForURL(/\/r\/[0-9a-f]{64}/, { timeout: 20_000 });
  await page.getByLabel(/おなまえ/).fill("ホスト");
  await page.getByRole("button", { name: "へやにはいる" }).click();
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};

// Invitee path: the copied invite link -> name panel -> join.
export const joinViaLink = async (
  browser: Browser,
  contexts: BrowserContext[],
  invite: string,
  name: string,
): Promise<Page> => {
  const page = await newPage(browser, contexts);
  await page.goto(invite);
  await page.getByLabel(/おなまえ/).fill(name);
  await page.getByRole("button", { name: "へやにはいる" }).click();
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
  return page;
};

// A lobby unload vacates the seat — the stored session dies on the error
// stage and re-entry joins fresh through the invite link.
export const rejoinViaInvite = async (page: Page, invite: string, name: string): Promise<void> => {
  await page.getByText(/招待リンクから入り直してください/).waitFor({ timeout: 20_000 });
  await page.goto(invite);
  // Hash-only navigations stay same-document; remount so the fragment is read.
  await page.reload();
  await page.getByLabel(/おなまえ/).fill(name);
  await page.getByRole("button", { name: "へやにはいる" }).click();
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
};

export const copyInvite = async (host: Page): Promise<string> => {
  await host.getByRole("button", { name: "招待リンクをコピー" }).click();
  const invite = await host.evaluate(() => navigator.clipboard.readText());
  expect(invite).toMatch(/\/r\/[0-9a-f]{64}\?[^#]*#[A-Za-z0-9_-]+/);
  // Per-user params never ride the shared link (RoomPage strips ?name=).
  expect(invite).not.toContain("name=");
  return invite;
};

export const turnOwner = async (pages: readonly Page[]): Promise<Page> => {
  for (const p of pages) if ((await p.locator("[data-turn-self]").count()) > 0) return p;
  throw new Error("no page holds the turn");
};
export const turnMoved = (page: Page, prev: string | null): Promise<unknown> =>
  page.waitForFunction(
    (p) => {
      const el = document.querySelector("[data-turn-player]");
      return el === null
        ? document.querySelector("[data-testid='room-results']") !== null
        : el.getAttribute("data-turn-player") !== p;
    },
    prev,
    { timeout: 30_000 },
  );

// The page whose turn strip says あなたのターン — pass or post through
// the real dock from that page only.
export const actTurn = async (
  pages: readonly Page[],
  kind: "post" | "pass",
  text: string,
): Promise<void> => {
  const watcher = pages[0] as Page;
  const prev = await watcher.locator("[data-turn-player]").getAttribute("data-turn-player");
  const actor = await turnOwner(pages);
  if (kind === "pass") {
    await actor.getByRole("button", { name: "パスする" }).click();
  } else {
    await actor.getByTestId("game-input").fill(text);
    await actor.getByTestId("send-button").click();
  }
  await turnMoved(watcher, prev);
};

// Every remaining turn posts from its own page's dock until the outcome
// dialog is up everywhere; returns the shared outcome text.
export const playMatch = async (pages: readonly Page[]): Promise<string> => {
  const watcher = pages[0] as Page;
  for (let step = 0; step < 24; step += 1) {
    await watcher.waitForFunction(
      () =>
        document.querySelector("[data-turn-player]") !== null ||
        document.querySelector("[data-testid='room-results']") !== null,
      { timeout: 45_000 },
    );
    if ((await watcher.getByTestId("room-results").count()) > 0) break;
    await actTurn(pages, "post", `ターン投稿${step}`);
  }
  const texts: string[] = [];
  for (const p of pages) {
    await p.getByTestId("room-results").waitFor({ timeout: 30_000 });
    texts.push((await p.getByTestId("results-outcome").textContent()) ?? "");
  }
  expect(new Set(texts).size).toBe(1);
  return texts[0] ?? "";
};

export const armContent = async (host: Page, member: Page, n: number): Promise<void> => {
  await host.locator("textarea").fill("夜のおやつ会議");
  await waitScenarioOn(member, "夜のおやつ会議");
  for (let i = 0; i < n; i += 1) {
    await host.locator(`[data-choice-id="c${i}"] input`).fill(`おやつ${i + 1}`);
    await waitChoiceLabelOn(member, `c${i}`, `おやつ${i + 1}`);
  }
};

export const readyStart = async (pages: readonly Page[]): Promise<void> => {
  for (const p of pages) await p.getByRole("button", { name: "準備OKにする" }).click();
  for (const p of pages) await waitReadyCount(p, pages.length);
  await (pages[0] as Page).getByRole("button", { name: "はじめる" }).click();
  for (const p of pages)
    await p.getByRole("heading", { name: "試合中" }).waitFor({ timeout: 20_000 });
};

const pick = (page: Page, name: string) =>
  page.locator('[data-settings="panel"]').getByRole("button", { name, exact: true });
export const pickAndSee = async (host: Page, member: Page, name: string): Promise<void> => {
  await pick(host, name).click();
  await expect(pick(member, name)).toHaveAttribute("aria-pressed", "true", {
    timeout: 20_000,
  });
};
