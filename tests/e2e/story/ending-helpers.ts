// Task 32/33 e2e shared ending harness: product pages (/r/<id>) drive
// game flow through the page's own RoomConnection (sendRaw) while every
// kamishibai assertion is a real DOM probe. The bridge layer never
// fabricates state — a panel exists in a test only because the server's
// ordered frames built it on the page.
import { expect, type Page } from "@playwright/test";
import { sendRaw } from "../lobby/helpers";

// Host arms the shared ledger from its own page (existing choice ids at
// the current revision — the commit rejects labels it did not grow),
// applies settings, every member readies on its own connection, then
// startGame flips the room. The dock's appearance is the playing phase.
export const armAndStart = async (
  host: Page,
  all: readonly Page[],
  opts: {
    scenario: string;
    choices: readonly string[];
    settings: Record<string, unknown>;
  },
): Promise<void> => {
  // Choice rows exist once the lobby ledger is readable; there may be
  // MORE rows than our labels (uncommitted extras), so wait for >= n.
  await host.waitForFunction(
    (n) => document.querySelectorAll("[data-choice-id]").length >= n,
    opts.choices.length,
    { timeout: 20_000 },
  );
  const choiceIds = await host.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-choice-id]")].map(
      (el) => el.dataset.choiceId ?? "",
    ),
  );
  const revision = await host.evaluate(
    () =>
      Number(
        document.querySelector("[data-lobby-revision]")?.getAttribute("data-lobby-revision"),
      ) || 0,
  );
  await sendRaw(host, "updateLobbyContent", {
    scenario: opts.scenario,
    choices: choiceIds.slice(0, opts.choices.length).map((choiceId, i) => ({
      choiceId,
      label: opts.choices[i] ?? "",
    })),
    expectedLobbyRevision: revision,
  });
  await sendRaw(host, "updateLobby", opts.settings);
  for (const p of all) await sendRaw(p, "setReady", { ready: true });
  await sendRaw(host, "startGame", {});
  for (const p of all) await p.getByTestId("room-dock").waitFor({ timeout: 20_000 });
};

// One "かたより" feed line == one decisionUpdated frame landed on this
// page. Sequential posts each earn their own evaluation (the debounce
// collapses only posts that arrive mid-flight), which is what gives the
// extractor several decisions to pick panels from.
const waitTilts = (page: Page, minCount: number): Promise<unknown> =>
  page.waitForFunction(
    (n) =>
      [...document.querySelectorAll("[data-testid='feed-line']")].filter((el) =>
        el.textContent?.includes("かたより"),
      ).length >= n,
    minCount,
    { timeout: 30_000 },
  );

// Post round-robin across the given pages, waiting for each evaluation
// to land on EVERY page before the next post — an un-evaluated post
// contributes no decision event and the story would lose its quotes.
export const postWithTilts = async (
  pages: readonly Page[],
  texts: readonly string[],
): Promise<void> => {
  const watcher = pages[0];
  if (watcher === undefined) throw new Error("postWithTilts needs pages");
  // The start-of-game baseline evaluation can land a "かたより" line
  // before the first post — count from what is already on screen so the
  // post-bound lines are never confused with it.
  const base = await watcher.evaluate(
    () =>
      [...document.querySelectorAll("[data-testid='feed-line']")].filter((el) =>
        el.textContent?.includes("かたより"),
      ).length,
  );
  for (const [i, t] of texts.entries()) {
    const page = pages[i % pages.length];
    if (page === undefined) throw new Error("postWithTilts needs pages");
    await sendRaw(page, "submitText", { text: t });
    for (const w of pages) await waitTilts(w, base + i + 1);
  }
};

// Host decision (requires hostDecision: true in settings) ends the live
// match; every page then waits out the pending line for the real panels.
// The reader renders one page at a time, so "the story arrived" is the
// pager's page-count, not a panel count.
export const finishMatch = async (pages: readonly Page[], host: Page): Promise<void> => {
  await sendRaw(host, "requestDecision", {});
  for (const p of pages) {
    await p.getByTestId("room-results").waitFor({ timeout: 30_000 });
    await p.getByTestId("page-count").waitFor({ timeout: 15_000 });
  }
};

export const storySize = async (page: Page): Promise<number> => {
  const text = (await page.getByTestId("page-count").textContent()) ?? "";
  const m = /\/\s*(\d+)/.exec(text);
  return m === null ? 0 : Number(m[1]);
};

export interface PanelView {
  readonly kind: string | null;
  readonly title: string;
  readonly caption: string;
  readonly quotes: readonly string[];
}

// The full story as this member sees it: page through the local reader,
// capturing kind/title/caption/quotes per panel. Paging is local state,
// so collecting on one page never disturbs another member's position.
export const collectPanels = async (page: Page): Promise<PanelView[]> => {
  const n = await storySize(page);
  if (n < 1) throw new Error("collectPanels: no story on the page");
  // Normalize to page 1 — a caller may have paged ahead on purpose
  // (self-paced paging), and reading mid-story would corrupt the set.
  for (let guard = 0; guard < 8; guard += 1) {
    const text = (await page.getByTestId("page-count").textContent()) ?? "";
    if (text.trimStart().startsWith("1")) break;
    await page.getByTestId("panel-prev").click();
  }
  await expect(page.getByTestId("page-count")).toHaveText("1 / ".concat(String(n)));
  const out: PanelView[] = [];
  for (let i = 0; i < n; i += 1) {
    const panel = page.getByTestId("kamishibai-panel");
    out.push({
      kind: await panel.getAttribute("data-kind"),
      title: (await panel.getByTestId("panel-title").textContent()) ?? "",
      caption: (await panel.getByTestId("panel-caption").textContent()) ?? "",
      quotes: await panel.getByTestId("panel-quote").allTextContents(),
    });
    if (i < n - 1) {
      await page.getByTestId("panel-next").click();
      await expect(page.getByTestId("page-count")).toHaveText(`${i + 2} / ${n}`);
    }
  }
  return out;
};
