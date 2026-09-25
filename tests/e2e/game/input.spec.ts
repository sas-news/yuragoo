// Task 13: IME-safe party input + non-numeric HUD on the /dev/game harness.
// Drives a real four-player TURN match through reduce(): composition Enter
// never submits, the 140-grapheme cap is enforced on graphemes (not UTF-16),
// posts clear only on ack, markup is inert, and the dock never overlaps the
// stage.
import { expect, test } from "@playwright/test";
import {
  clickSend,
  composingEnter,
  dispatchAllTurns,
  feedItems,
  fillPost,
  gotoGame,
  imeEnd,
  imeStart,
  nameOf,
  postViaUi,
  seatOf,
} from "./helpers";

test("happy: stage, roster chips, turn line and dock layout render", async ({ page }) => {
  await gotoGame(page);
  await expect(page.getByTestId("roster-chip")).toHaveCount(4);
  const seat = await seatOf(page);
  await expect(page.getByTestId("turn-line")).toHaveText(`${nameOf(seat)} の番です`);
  await expect(page.getByTestId("deadline-bar")).toBeAttached();
  // The dock sits below the stage in normal flow — no overlap either way.
  const stage = await page.getByTestId("creature-stage").boundingBox();
  const input = await page.getByTestId("game-input").boundingBox();
  const send = await page.getByTestId("send-button").boundingBox();
  expect(stage).not.toBeNull();
  expect(input).not.toBeNull();
  expect(send).not.toBeNull();
  if (stage !== null && input !== null && send !== null) {
    expect(input.y).toBeGreaterThanOrEqual(stage.y + stage.height);
    expect(send.y).toBeGreaterThanOrEqual(stage.y + stage.height);
  }
});

test("happy: IME Enter never submits during composition", async ({ page }) => {
  await gotoGame(page);
  const input = page.getByTestId("game-input");
  await input.focus();
  await imeStart(page);
  await page.keyboard.insertText("にほんご");
  // Enter while the composition ref is held confirms the candidate — no post.
  await input.press("Enter");
  // A native keydown that still reports isComposing is ignored too.
  await composingEnter(page);
  await page.waitForTimeout(350);
  await expect(feedItems(page)).toHaveCount(0);
  await imeEnd(page, "にほんご");
  await input.press("Enter");
  await expect(feedItems(page)).toHaveCount(1);
  await expect(feedItems(page).last()).toContainText("にほんご");
});

test("happy: 140 graphemes including combining marks are accepted", async ({ page }) => {
  await gotoGame(page);
  // か+゙ counts as ONE grapheme but two UTF-16 units.
  const text = `${"あ".repeat(139)}が`;
  await fillPost(page, text);
  await expect(page.getByTestId("input-counter")).toHaveText("残り 0");
  await clickSend(page);
  await expect(feedItems(page)).toHaveCount(1);
});

test("failure: the 141st grapheme shows an error and blocks submit", async ({ page }) => {
  await gotoGame(page);
  await fillPost(page, `${"あ".repeat(140)}が`); // 141 graphemes
  // The error also announces how many graphemes are over (Task 27).
  await expect(page.getByTestId("input-error")).toContainText("文字数オーバー");
  await clickSend(page);
  await expect(feedItems(page)).toHaveCount(0);
  await expect(page.getByTestId("input-error")).toContainText("文字数オーバー");
});

test("happy: draft clears only on ack, button disabled while pending", async ({ page }) => {
  await gotoGame(page);
  await fillPost(page, "かんがえてね");
  await clickSend(page);
  await expect(page.getByTestId("send-button")).toBeDisabled();
  // Still pending: the draft is kept and the post is already visible.
  await expect(page.getByTestId("game-input")).toHaveValue("かんがえてね");
  await expect(feedItems(page)).toHaveCount(1);
  // The ~300ms simulated evaluation acks -> pending->idle clears the draft.
  await expect(page.getByTestId("game-input")).toHaveValue("");
  await expect(page.getByTestId("send-button")).toBeEnabled();
});

test("happy: turn line advances to the next player after a post", async ({ page }) => {
  await gotoGame(page);
  const first = await seatOf(page);
  await postViaUi(page, "いってみよう");
  const second = await seatOf(page);
  expect(second).not.toBe(first);
  await expect(page.getByTestId("turn-line")).toHaveText(`${nameOf(second)} の番です`);
});

test("failure: script markup posts as literal text, no dialog fires", async ({ page }) => {
  let dialogSeen = false;
  page.on("dialog", () => {
    dialogSeen = true;
  });
  await gotoGame(page);
  await postViaUi(page, "<script>alert(1)</script>");
  await expect(feedItems(page).last()).toContainText("<script>alert(1)</script>");
  await page.waitForTimeout(400);
  expect(dialogSeen).toBe(false);
});

test("failure: whitespace-only input is rejected with an error", async ({ page }) => {
  await gotoGame(page);
  await fillPost(page, "　 　\t");
  await clickSend(page);
  await expect(page.getByTestId("input-error")).toHaveText("なにか書いてね");
  await expect(feedItems(page)).toHaveCount(0);
});

test("failure: rapid double submit posts exactly once", async ({ page }) => {
  await gotoGame(page);
  const input = page.getByTestId("game-input");
  await fillPost(page, "ダブルチェック");
  await input.press("Enter");
  await input.press("Enter");
  await clickSend(page);
  await expect(feedItems(page)).toHaveCount(1);
});

test("failure: a long URL posts as text without breaking the feed", async ({ page }) => {
  await gotoGame(page);
  const url = `https://example.com/${"とてもながいパス".repeat(14)}`;
  await postViaUi(page, url);
  await expect(feedItems(page).last()).toContainText("https://example.com/");
  const feed = page.getByTestId("feed-list");
  const overflows = await feed.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(overflows).toBe(false);
});

test("happy: the live announcer speaks only the latest post", async ({ page }) => {
  await gotoGame(page);
  await postViaUi(page, "いっぽんめ");
  const secondSeat = await seatOf(page);
  await postViaUi(page, "にほんめ");
  const announcer = page.getByTestId("live-announcer");
  expect(await announcer.textContent()).toBe(`${nameOf(secondSeat)} が投稿：にほんめ`);
  await expect(feedItems(page)).toHaveCount(2);
});

test("failure: input is disabled once the game leaves playing", async ({ page }) => {
  await gotoGame(page);
  await dispatchAllTurns(page, 12); // 4 players x 3 rounds -> complete
  await expect(page.getByTestId("turn-line")).toHaveText("結果をまとめています");
  await page.waitForTimeout(450); // let the pending evaluations land
  await expect(page.getByTestId("game-input")).toBeDisabled();
  await expect(page.getByTestId("send-button")).toBeDisabled();
  await expect(page.getByTestId("input-hint")).toHaveText("このゲームはおわったよ");
});
