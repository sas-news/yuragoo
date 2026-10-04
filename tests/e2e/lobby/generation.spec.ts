// Task 25 e2e: one-shot AI choice generation on real /r/<id> pages
// against the real wrangler worker — the deterministic :8792 fixture
// stands in for Workers AI (never a paid call). Covers the click-only
// gate, host-only proposal, apply-through-updateLobbyContent, the spent
// slot, and the garbage-response failure path.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoom,
  joinPage,
  revision,
  sendRawError,
  waitChoiceLabelOn,
  waitChoiceRows,
  waitMemberCount,
  waitScenarioOn,
} from "./helpers";
import { startGenerationFixture, type GenerationFixture } from "./gen-fixture";

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const EVIDENCE_DIR = join(process.cwd(), ".omo/evidence/yuragoo-development", `${stamp}-t25`);

let fixture: GenerationFixture;
const contexts: BrowserContext[] = [];
test.beforeAll(async () => {
  fixture = await startGenerationFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.afterEach(async () => {
  fixture.mode = "ok";
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});

const seat = async (
  browser: Browser,
  roomId: string,
  secret: string,
  name: string,
  videoDir?: string,
): Promise<Page> => {
  const ctx = await browser.newContext(
    videoDir === undefined ? {} : { recordVideo: { dir: videoDir } },
  );
  contexts.push(ctx);
  const page = await ctx.newPage();
  await joinPage(page, roomId, secret, name);
  return page;
};

const genButton = (page: Page) =>
  page.getByRole("button", { name: /AIで選択肢を生成|もう一度生成/ });

test("happy: host generates, applies the proposal, edits stay manual", async ({ browser }) => {
  test.setTimeout(120_000);
  const videoDir = mkdtempSync(join(tmpdir(), "yuragoo-t25-video-"));
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト", videoDir);
  const members: Page[] = [];
  for (let i = 0; i < 3; i += 1) {
    members.push(await seat(browser, room.roomId, room.inviteSecret, `メンバー${i + 1}`));
    await waitMemberCount(host, i + 2);
  }
  const member0 = members[0] as Page;
  await waitChoiceRows(host, 4);
  await host.locator("textarea").fill("夜のおやつ会議");
  await waitScenarioOn(member0, "夜のおやつ会議");

  // Click-only: nothing happens without the explicit button press, and
  // non-host pages never even render the button.
  await expect(genButton(member0)).toHaveCount(0);
  await expect(genButton(host)).toBeEnabled();
  await genButton(host).click();
  const labels = host.locator("[data-proposal-label]");
  await expect(labels).toHaveCount(4, { timeout: 20_000 });
  await expect(labels.first()).toHaveText("生成案1");
  // The proposal is host-only — member pages show nothing of it.
  expect(await member0.locator("[data-proposal-label]").count()).toBe(0);
  expect(await member0.locator("text=生成案1").count()).toBe(0);
  // The lobby itself is untouched until the host applies.
  await expect(host.locator('[data-choice-id="c0"] input')).toHaveValue("");

  await host.getByRole("button", { name: "生成案を適用" }).click();
  await expect(labels).toHaveCount(0, { timeout: 20_000 });
  for (let i = 0; i < 4; i += 1) {
    await waitChoiceLabelOn(member0, `c${i}`, `生成案${i + 1}`);
  }
  for (const m of members.slice(1)) await waitChoiceLabelOn(m, "c3", "生成案4");
  // Re-generation is allowed: the button stays enabled, now もう一度生成.
  await expect(genButton(host)).toBeEnabled();
  await expect(genButton(host)).toContainText("もう一度生成");

  // Manual editing still works after apply — the host rewrites c0.
  await host.locator('[data-choice-id="c0"] input').fill("手直しのおやつ");
  await waitChoiceLabelOn(member0, "c0", "手直しのおやつ");

  const video = host.video();
  await host.context().close();
  if (video !== null) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    copyFileSync(await video.path(), join(EVIDENCE_DIR, "task-25-happy.webm"));
  }
});

test("failure: garbage upstream shows an error, frees the slot", async ({ browser }) => {
  test.setTimeout(120_000);
  fixture.mode = "garbage";
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  await host.locator("textarea").fill("失敗するシナリオ");
  await waitScenarioOn(member, "失敗するシナリオ");

  await genButton(host).click();
  await expect(host.locator('[role="alert"]')).toContainText("生成に失敗", {
    timeout: 20_000,
  });
  // Member pages never see the failure surface either — host-only UI.
  expect(await member.locator('[role="alert"]').count()).toBe(0);
  // The slot is released on failure — the button comes back for a retry.
  await expect(genButton(host)).toBeEnabled();
  expect(await sendRawError(host, "generateChoices", {})).not.toContain("generation-spent");
  // Manual editing remains fully functional after the failure.
  await host.locator('[data-choice-id="c0"] input').fill("手入力の選択肢");
  await waitChoiceLabelOn(member, "c0", "手入力の選択肢");

  const rev = await revision(host);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, "task-25-failure.log"),
    [
      `roomId=${room.roomId}`,
      `lobbyRevision=${rev}`,
      `fixtureRequests=${fixture.requests.length}`,
      ...fixture.requests,
      "hostError=選択肢の生成に失敗しました — もう一度試すか手入力で続けられます",
      "slotSpent=false secondAttempt=accepted manualEdit=ok",
      "",
    ].join("\n"),
  );
});
