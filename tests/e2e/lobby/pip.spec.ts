// Task 49 phone support: the pixel-tier PIP fallback must fire only for a
// small WINDOW on a big screen — never on a small-screen device (a phone),
// where the glance surface would replace the editable lobby and hide the
// input dock. Playwright's `screen` context option emulates the device
// metrics, so both halves of the gate are exercisable end-to-end.
// Assertions stay locale-agnostic: headless browsers negotiate "en" while
// the product voice is "ja" — count controls, not labels.
import { expect, test, type BrowserContext } from "@playwright/test";
import { createRoom, joinPage } from "./helpers";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});

test("phone-sized screens keep the editable lobby — PIP stays a window mode", async ({
  browser,
}) => {
  // Portrait phone (390x844) and landscape (844x390): the screen's short
  // edge is <=500 in both, so data-pip must never appear — the lobby
  // keeps its editable inputs (scenario + choice textareas) and the
  // settings panel the glance view drops entirely.
  for (const [w, h] of [
    [390, 844],
    [844, 390],
  ] as const) {
    const room = await createRoom();
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await joinPage(page, room.roomId, room.inviteSecret, "ホスト");
    await expect(page.locator("html")).not.toHaveAttribute("data-pip");
    await expect(page.locator("textarea").first()).toBeVisible();
    await expect(page.locator('[data-settings="panel"]')).toBeVisible();
  }
});

test("a small window on a big screen still flips to the PIP glance lobby", async ({ browser }) => {
  const room = await createRoom();
  // 400x400 window on a 1280x800 screen: the pixel tier matches AND the
  // device is not small — the pop-out glance surface takes over, so no
  // editable textarea remains.
  const ctx = await browser.newContext({
    viewport: { width: 400, height: 400 },
    screen: { width: 1280, height: 800 },
  });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await joinPage(page, room.roomId, room.inviteSecret, "ホスト");
  await expect(page.locator("html")).toHaveAttribute("data-pip", "true");
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByRole("button").first()).toBeVisible();
});
