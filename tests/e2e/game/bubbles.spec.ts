// Task 13e: posts pop as big readable bubbles on the INWARD side of the
// poster's seat chip — between the chip and the creature. They never
// travel: pop-in ~380ms, hold ~4.5s, pop-out ~320ms, unmount ~4.8s. The
// silhouette is a measured SVG path (chamfered rect + tail spike) with one
// uniform teal stroke; the spike aims back at the chip via atan2 — right
// side too.
import { expect, test } from "@playwright/test";
import {
  clickSend,
  dispatchOneTurn,
  feedItems,
  fillPost,
  gameState,
  gotoGame,
  layoutOf,
  postViaUi,
  seatOf,
  waitForRuntime,
} from "./helpers";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const dist = (box: Box, point: { x: number; y: number }) =>
  Math.hypot(box.x + box.width / 2 - point.x, box.y + box.height / 2 - point.y);
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const normDeg = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

test("happy: seats sit on their attractor posts, clear of dock and each other", async ({
  page,
}) => {
  await gotoGame(page);
  await waitForRuntime(page);
  await expect(page.locator("[data-testid^='seat-']")).toHaveCount(4);
  const layout = await layoutOf(page);
  const state = await gameState(page);
  const stageBox = await page.getByTestId("creature-stage").boundingBox();
  const sendBox = await page.getByTestId("send-button").boundingBox();
  if (layout === null || state === null || stageBox === null || sendBox === null) {
    throw new Error("stage not ready");
  }
  const stageC = {
    x: stageBox.x + layout.stageWidth / 2,
    y: stageBox.y + layout.stageHeight / 2,
  };
  const boxes: Box[] = [];
  for (const player of state.roster) {
    const attractor = layout.attractorCenters[player.slot];
    const box = await page.getByTestId(`seat-${player.id}`).boundingBox();
    expect(attractor).toBeDefined();
    expect(box).not.toBeNull();
    if (attractor === undefined || box === null) continue;
    boxes.push(box);
    const post = { x: stageBox.x + attractor.x, y: stageBox.y + attractor.y };
    // The chip's anchor point — the avatar icon's center — IS the
    // attractor post (clamped at the edges). The chip box extends inward
    // from it, so box geometry is not the seat position.
    const seat = page.getByTestId(`seat-${player.id}`);
    const anchorX = Number(await seat.getAttribute("data-anchor-x"));
    const anchorY = Number(await seat.getAttribute("data-anchor-y"));
    expect(Math.hypot(anchorX - attractor.x, anchorY - attractor.y)).toBeLessThan(120);
    const anchor = { x: stageBox.x + anchorX, y: stageBox.y + anchorY };
    // OUTWARD_PX is 0 and edge clamps only pull the chip INWARD — the
    // anchor may sit on the post or inside it, never outward past it.
    const dot =
      (anchor.x - post.x) * (post.x - stageC.x) + (anchor.y - post.y) * (post.y - stageC.y);
    expect(dot).toBeLessThanOrEqual(1);
    // No seat ever slides under the dock's send button.
    expect(overlaps(box, sendBox)).toBe(false);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a !== undefined && b !== undefined) expect(overlaps(a, b)).toBe(false);
    }
  }
});

test("happy: a post pops a big bubble INSIDE the ring that never travels", async ({ page }) => {
  await gotoGame(page);
  await waitForRuntime(page);
  const seat = await seatOf(page);
  const seatBox = await page.getByTestId(`seat-${seat}`).boundingBox();
  const stageBox = await page.getByTestId("creature-stage").boundingBox();
  if (seatBox === null || stageBox === null) throw new Error("stage not ready");
  const seatC = center(seatBox);
  const stageC = center(stageBox);
  await fillPost(page, "ゆらゆらいこう");
  await clickSend(page);
  const bubble = page.getByTestId("bubble-p1");
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAttribute("data-motion", "pop");
  // Anchored on the chip's INWARD side: closer to the creature than the
  // seat itself, and never on top of the chip.
  const first = await bubble.boundingBox();
  if (first === null) throw new Error("bubble missing");
  const seatDist = Math.hypot(seatC.x - stageC.x, seatC.y - stageC.y);
  expect(dist(first, stageC)).toBeLessThan(seatDist + 1);
  expect(dist(first, seatC)).toBeGreaterThan(40);
  expect(dist(first, seatC)).toBeLessThan(520);
  expect(overlaps(first, seatBox)).toBe(false);
  // +0.8s and +2.5s: the bubble does NOT travel (<2px movement).
  await page.waitForTimeout(800);
  const early = await bubble.boundingBox();
  await page.waitForTimeout(1700);
  const late = await bubble.boundingBox();
  if (early === null || late === null) throw new Error("bubble gone early");
  expect(
    Math.hypot(center(late).x - center(early).x, center(late).y - center(early).y),
  ).toBeLessThan(2);
  // Still up around ~4s, unmounted well before ~6s (pop-out ends ~4.8s).
  await page.waitForTimeout(1400);
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveCount(0, { timeout: 2400 });
});

test("happy: EVERY bubble sits inward, clears chips, stays in-arena, tail aims", async ({
  page,
}) => {
  await gotoGame(page);
  await waitForRuntime(page);
  await expect(page.locator("[data-testid^='seat-']")).toHaveCount(4);
  const stageBox = await page.getByTestId("creature-stage").boundingBox();
  const state = await gameState(page);
  if (stageBox === null || state === null) throw new Error("stage not ready");
  const seatBoxes: Record<string, Box> = {};
  for (const player of state.roster) {
    const box = await page.getByTestId(`seat-${player.id}`).boundingBox();
    if (box !== null) seatBoxes[player.id] = box;
  }
  // One post per player via the bridge (post -> evaluated): 4 live bubbles.
  const posted: { postId: string; playerId: string }[] = [];
  for (let i = 0; i < 4; i += 1) {
    const p = await dispatchOneTurn(page, `たいむ${i}`);
    if (p !== null) posted.push(p);
  }
  expect(posted.length).toBe(4);
  await page.waitForTimeout(500); // let the pop-in settle before measuring
  for (const { postId, playerId } of posted) {
    const bubble = page.getByTestId(`bubble-${postId}`);
    await expect(bubble).toBeVisible();
    const box = await bubble.boundingBox();
    const seatBox = seatBoxes[playerId];
    const attr = await bubble.getAttribute("data-tail-angle");
    if (box === null || seatBox === undefined || attr === null) {
      throw new Error(`bubble ${postId} missing pieces`);
    }
    const bubC = center(box);
    const seatC = center(seatBox);
    const stageC = center(stageBox);
    // Inside the arena (the 10px margin is built into the anchor).
    expect(box.x).toBeGreaterThanOrEqual(stageBox.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(stageBox.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 1);
    // Inward of its seat — between the chip and the creature.
    expect(dist(box, stageC)).toBeLessThan(dist(seatBox, stageC) + 1);
    // …and no seat chip is covered either.
    for (const other of Object.values(seatBoxes)) expect(overlaps(box, other)).toBe(false);
    // Uniform SVG outline: the measured frame exists, stroked >= 2px.
    await expect(bubble.getByTestId("bubble-frame")).toBeAttached();
    const sw = await bubble
      .getByTestId("bubble-outline")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).strokeWidth));
    expect(sw).toBeGreaterThanOrEqual(2);
    // The spike aims at its own seat (within ~20deg of the measured vector).
    const expected = (Math.atan2(seatC.y - bubC.y, seatC.x - bubC.x) * 180) / Math.PI;
    expect(Math.abs(normDeg(expected - Number(attr)))).toBeLessThan(20);
    const tail = await bubble.getByTestId("bubble-tail").boundingBox();
    if (tail === null) throw new Error("tail missing");
    const t = center(tail);
    expect(
      (t.x - bubC.x) * (seatC.x - bubC.x) + (t.y - bubC.y) * (seatC.y - bubC.y),
    ).toBeGreaterThan(0);
  }
});

test("happy: a new post from the same player replaces their bubble", async ({ page }) => {
  await gotoGame(page);
  await waitForRuntime(page);
  for (let i = 0; i < 4; i += 1) await dispatchOneTurn(page, `まわる${i}`);
  const seat = await seatOf(page); // round 1's first poster — already bubbled
  const earlier = (await gameState(page))?.posts.find((p) => p.playerId === seat);
  if (earlier === undefined) throw new Error("no earlier post");
  await expect(page.getByTestId("send-button")).toBeEnabled();
  await postViaUi(page, "あたらしくいくよ");
  const fresh = (await gameState(page))?.posts.find(
    (p) => p.playerId === seat && p.postId !== earlier.postId,
  );
  if (fresh === undefined) throw new Error("no fresh post");
  await expect(page.getByTestId(`bubble-${fresh.postId}`)).toBeVisible();
  // The player's previous bubble is replaced immediately, not left to age out.
  await expect(page.getByTestId(`bubble-${earlier.postId}`)).toHaveCount(0);
});

test("happy: seat glow follows the turn, and the creature flickers on a post", async ({ page }) => {
  await gotoGame(page);
  const first = await seatOf(page);
  await expect(page.getByTestId(`seat-${first}`)).toHaveAttribute("data-current", "true");
  await postViaUi(page, "つぎいこう");
  const second = await seatOf(page);
  expect(second).not.toBe(first);
  await expect(page.getByTestId(`seat-${second}`)).toHaveAttribute("data-current", "true");
  await expect(page.getByTestId(`seat-${first}`)).not.toHaveAttribute("data-current", "true");
  // The creature visibly "heard" the post, then settles on its own (~950ms).
  const stage = page.getByTestId("creature-stage");
  await postViaUi(page, "きいてきいて");
  await expect(stage).toHaveAttribute("data-state", "hesitating");
  await expect(stage).toHaveAttribute("data-state", "normal", { timeout: 4000 });
});

test("happy: reduced motion fades the anchored bubble without popping", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoGame(page);
  await waitForRuntime(page);
  const seat = await seatOf(page);
  const seatBox = await page.getByTestId(`seat-${seat}`).boundingBox();
  await fillPost(page, "しずかにいこう");
  await clickSend(page);
  const bubble = page.getByTestId("bubble-p1");
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAttribute("data-motion", "reduced");
  // Anchored inward of the seat — and it stays put.
  const box = await bubble.boundingBox();
  if (seatBox === null || box === null) throw new Error("missing boxes");
  expect(dist(box, center(seatBox))).toBeLessThan(520);
  expect(overlaps(box, seatBox)).toBe(false);
  await page.waitForTimeout(1200);
  const later = await bubble.boundingBox();
  if (later === null) throw new Error("bubble gone early");
  expect(Math.hypot(center(later).x - center(box).x, center(later).y - center(box).y)).toBeLessThan(
    2,
  );
  // Fades out and unmounts like the normal path (~4.8s total).
  await expect(bubble).toHaveCount(0, { timeout: 5000 });
});

test("happy: the feed still logs the post while the bubble is up", async ({ page }) => {
  await gotoGame(page);
  await postViaUi(page, "ろぐにものこる");
  await expect(feedItems(page).last()).toContainText("ろぐにものこる");
  await expect(feedItems(page)).toHaveCount(1);
});
