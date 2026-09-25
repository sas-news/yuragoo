// Playwright helpers for the /dev/game harness (Task 13). The bridge global
// mirrors apps/web/src/dev/GameDev.tsx's __gameBridge; the module graph is
// not importable here (pulls pixi.js), so types are imported type-only.
import { expect, type Page } from "@playwright/test";
import type { GameAction, GameState } from "@yuragoo/game-core";

declare global {
  interface Window {
    __gameBridge?: {
      state(): GameState;
      dispatch(action: GameAction): { phase: string; seq: number };
      layout(): {
        stageWidth: number;
        stageHeight: number;
        bodyBounds: { x: number; y: number; width: number; height: number };
        attractorCenters: readonly { x: number; y: number }[];
      } | null;
      readonly events: readonly { type: string }[];
    };
  }
}

export const NAMES: Readonly<Record<string, string>> = {
  aiko: "あいこ",
  ren: "れん",
  yuu: "ゆう",
  riku: "りく",
};

export const nameOf = (id: string | undefined): string =>
  id === undefined ? "?" : (NAMES[id] ?? id);

export const gotoGame = async (page: Page): Promise<void> => {
  await page.goto("/dev/game");
  await page.waitForFunction(() => window.__gameBridge !== undefined);
  await expect(page.getByTestId("game-dev")).toBeVisible();
};

export const gameState = (page: Page): Promise<GameState | null> =>
  page.evaluate(() => window.__gameBridge?.state() ?? null);

export const seatOf = async (page: Page): Promise<string> => {
  const state = await gameState(page);
  return state?.turnOrder[state.turnIndex] ?? "";
};

// The creature runtime mounts asynchronously; seats appear once the bridge
// can answer layout(). Await this before asserting on seats or bubbles.
export const waitForRuntime = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("creature-stage")).toHaveAttribute("data-status", "ready");
  await page.waitForFunction(() => (window.__gameBridge?.layout() ?? null) !== null);
};

export const layoutOf = (page: Page) => page.evaluate(() => window.__gameBridge?.layout() ?? null);

export const feedItems = (page: Page) => page.getByTestId("feed-item");

export const fillPost = (page: Page, text: string) => page.getByTestId("game-input").fill(text);

export const clickSend = (page: Page) => page.getByTestId("send-button").click();

export const postViaUi = async (page: Page, text: string): Promise<void> => {
  const before = await feedItems(page).count();
  await fillPost(page, text);
  await clickSend(page);
  await expect(feedItems(page)).toHaveCount(before + 1);
};

// Simulated IME session. A real key press cannot set isComposing, so the
// composition events drive the component's composing ref exactly like a
// browser IME does; insertText lands the text through a trusted input event.
export const imeStart = (page: Page) =>
  page.getByTestId("game-input").evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  });

export const imeEnd = (page: Page, data = "") =>
  page.getByTestId("game-input").evaluate((el, committed) => {
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: committed }));
  }, data);

export const composingEnter = (page: Page) =>
  page.getByTestId("game-input").evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
  });

// Drive posts straight through the bridge — the same reduce() the UI uses,
// skipping the 300ms simulated evaluation per post.
export const dispatchAllTurns = (page: Page, count: number) =>
  page.evaluate((n) => {
    const bridge = window.__gameBridge;
    if (bridge === undefined) return;
    for (let i = 0; i < n; i += 1) {
      const state = bridge.state();
      const seat = state.turnOrder[state.turnIndex];
      if (state.phase !== "playing" || seat === undefined) return;
      bridge.dispatch({ type: "post", playerId: seat, text: `はやぶさ${i}`, nowMs: Date.now() });
    }
  }, count);

// Post once as the current turn player, then ack the evaluation — one full
// turn through the real reduce(). Returns the new post's id + poster.
export const dispatchOneTurn = (page: Page, text: string) =>
  page.evaluate((t) => {
    const bridge = window.__gameBridge;
    if (bridge === undefined) return null;
    const seat = bridge.state().turnOrder[bridge.state().turnIndex];
    if (seat === undefined) return null;
    bridge.dispatch({ type: "post", playerId: seat, text: t, nowMs: Date.now() });
    const post = bridge.state().posts.at(-1);
    if (post !== undefined) bridge.dispatch({ type: "evaluated", postId: post.postId });
    return { postId: post?.postId ?? "", playerId: seat };
  }, text);
