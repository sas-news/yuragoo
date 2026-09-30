// Task 24 gate: the host-editable synchronized lobby end to end on real
// /r/<id> pages — edit/ready/start convergence, membership-driven choice
// rows with orphan drafts, every rejection path, and the dirty-field
// merge rule. Pages are real browser contexts talking to real wrangler.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoom,
  EVIDENCE_DIR,
  joinPage,
  revision,
  sendRaw,
  sendRawError,
  waitChoiceLabelOn,
  waitChoiceRows,
  waitMemberCount,
  waitOrphanCount,
  waitReadyCount,
  waitScenarioOn,
} from "./helpers";

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
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

test("happy: four members share one lobby, ready up and start", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const members: Page[] = [];
  for (let i = 0; i < 3; i += 1) {
    members.push(await seat(browser, room.roomId, room.inviteSecret, `メンバー${i + 1}`));
    await waitMemberCount(host, i + 2);
  }
  const all = [host, ...members];
  for (const p of all) await waitChoiceRows(p, 4);

  // Host edits through the real fields; every member sees each change land.
  await host.locator("textarea").fill("夜のおやつ会議");
  for (const m of members) await waitScenarioOn(m, "夜のおやつ会議");
  for (let i = 0; i < 4; i += 1) {
    await host.locator(`[data-choice-id="c${i}"] input`).fill(`おやつ${i + 1}`);
    await waitChoiceLabelOn(members[0] as Page, `c${i}`, `おやつ${i + 1}`);
  }
  // A trailing conflict-retry may land one extra revision — the contract
  // is that every seat converges on the same number, whichever is newest.
  await expect
    .poll(async () => new Set(await Promise.all(all.map(revision))).size, {
      timeout: 20_000,
    })
    .toBe(1);

  for (const p of all) await p.getByRole("button", { name: "準備OKにする" }).click();
  for (const p of all) await waitReadyCount(p, 4);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await host.screenshot({ path: join(EVIDENCE_DIR, "task-24-happy.png") });

  await host.getByRole("button", { name: "はじめる" }).click();
  for (const p of all) {
    await p.getByRole("heading", { name: "試合中" }).waitFor({ timeout: 20_000 });
  }
});

test("membership: choice rows follow 2 -> 6 -> 4 -> 6 with orphan drafts", async ({ browser }) => {
  test.setTimeout(120_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  await seat(browser, room.roomId, room.inviteSecret, "メンバー1");
  await waitMemberCount(host, 2);
  await waitChoiceRows(host, 2);
  const extras: Page[] = [];
  for (let i = 0; i < 4; i += 1) {
    extras.push(await seat(browser, room.roomId, room.inviteSecret, `追加${i}`));
    await waitMemberCount(host, 3 + i);
  }
  await waitChoiceRows(host, 6);
  // Label all six so the orphan tail is provably preserved.
  await sendRaw(host, "updateLobbyContent", {
    scenario: "シナリオ",
    choices: [0, 1, 2, 3, 4, 5].map((i) => ({ choiceId: `c${i}`, label: `ドラフト${i}` })),
    expectedLobbyRevision: await revision(host),
  });
  // Host rows are inputs (host-only editing) — assert the value, not text.
  await expect(host.locator('[data-choice-id="c5"] input')).toHaveValue("ドラフト5");

  // Leaving is a two-step confirm now (Task 27 dialog).
  for (const p of [extras[2], extras[3]]) {
    await p?.getByRole("button", { name: "へやを出る" }).click();
    await p?.getByTestId("leave-confirm-yes").click();
  }
  await waitMemberCount(host, 4);
  await waitOrphanCount(host, 2);
  // Shrinking orphaned the tail — drafts and their ids survived intact.
  await expect(host.locator('[data-choice-id="c5"] input')).toHaveValue("ドラフト5");
  await expect(host.locator('[data-choice-id="c4"] input')).toHaveValue("ドラフト4");

  for (let i = 0; i < 2; i += 1) {
    await seat(browser, room.roomId, room.inviteSecret, `復帰${i}`);
    await waitMemberCount(host, 5 + i);
  }
  await waitOrphanCount(host, 0);
  await expect(host.locator('[data-choice-id="c5"] input')).toHaveValue("ドラフト5");
});

test("failure: host-only, revision, label and ready gates all hold", async ({ browser }) => {
  test.setTimeout(120_000);
  const videoDir = mkdtempSync(join(tmpdir(), "yuragoo-t24-video-"));
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト", videoDir);
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);

  expect(
    await sendRawError(member, "updateLobbyContent", {
      scenario: "乗っ取り",
      expectedLobbyRevision: 0,
    }),
  ).toContain("not-host");
  expect(
    await sendRawError(host, "updateLobbyContent", {
      scenario: "古い",
      expectedLobbyRevision: 999,
    }),
  ).toContain("lobby-revision-conflict");
  expect(await sendRawError(host, "startGame", {})).toContain("lobby-not-ready");

  for (const p of [host, member]) {
    await p.getByRole("button", { name: "準備OKにする" }).click();
  }
  await waitReadyCount(host, 2);
  await expect(host.getByRole("button", { name: "はじめる" })).toBeDisabled();
  expect(await sendRawError(host, "startGame", {})).toContain("lobby-scenario-empty");
  await sendRaw(host, "updateLobbyContent", {
    scenario: "ある",
    expectedLobbyRevision: await revision(host),
  });
  expect(await sendRawError(host, "startGame", {})).toContain("lobby-choice-empty");
  await sendRaw(host, "updateLobbyContent", {
    choices: [
      { choiceId: "c0", label: " 同じ " },
      { choiceId: "c1", label: "同じ" },
    ],
    expectedLobbyRevision: await revision(host),
  });
  expect(await sendRawError(host, "startGame", {})).toContain("lobby-choice-dup");
  expect(
    await sendRawError(host, "updateLobbyContent", {
      choices: [{ choiceId: "c0", label: "あ".repeat(45) }],
      expectedLobbyRevision: await revision(host),
    }),
  ).toContain("invalid-envelope");

  const video = host.video();
  await host.context().close();
  if (video !== null) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    copyFileSync(await video.path(), join(EVIDENCE_DIR, "task-24-failure.webm"));
  }
});

test("presets: お題をえらぶ opens the picker, a pick writes the field", async ({ browser }) => {
  test.setTimeout(60_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);

  const dialog = host.getByTestId("scenario-preset-dialog");
  await host.getByTestId("scenario-preset").click();
  // All ten built-ins render as choices inside an accessible dialog —
  // plus the やめる button.
  await expect(dialog.getByRole("button")).toHaveCount(11);
  const first = dialog.getByRole("button").first();
  const picked = await first.textContent();
  await first.click();
  await expect(dialog).toHaveCount(0);
  await expect(host.locator("textarea")).toHaveValue(picked ?? "");
  await waitScenarioOn(member, picked ?? "");

  // Reopen and dismiss — Escape leaves the field untouched.
  await host.getByTestId("scenario-preset").click();
  await host.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(host.locator("textarea")).toHaveValue(picked ?? "");
});

test("merge: a join mid-edit never clobbers the host's dirty field", async ({ browser }) => {
  test.setTimeout(90_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー1");
  await waitMemberCount(host, 2);
  await host.locator("textarea").fill("書きかけのシナリオ");
  // The join lands while the debounced draft is dirty/in-flight.
  await seat(browser, room.roomId, room.inviteSecret, "メンバー2");
  await waitMemberCount(host, 3);
  await waitChoiceRows(host, 3);
  await expect(host.locator("textarea")).toHaveValue("書きかけのシナリオ");
  // The debounced save still converges for everyone afterwards.
  await waitScenarioOn(member, "書きかけのシナリオ");
});

test("visual: lobby reads correctly at 375/768/1280 in every state", async ({ browser }) => {
  test.setTimeout(90_000);
  const room = await createRoom();
  const host = await seat(browser, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  let ready = false;
  for (const width of [375, 768, 1280]) {
    await host.setViewportSize({ width, height: 900 });
    await host.screenshot({ path: join(EVIDENCE_DIR, `task-24-lobby-${width}-default.png`) });
    await host.locator("textarea").fill(`シナリオ幅${width}`);
    await waitScenarioOn(member, `シナリオ幅${width}`);
    await host.screenshot({ path: join(EVIDENCE_DIR, `task-24-lobby-${width}-editing.png`) });
    if (!ready) {
      await host.getByRole("button", { name: "準備OKにする" }).click();
      await waitReadyCount(host, 1);
      ready = true;
    }
    await host.screenshot({ path: join(EVIDENCE_DIR, `task-24-lobby-${width}-ready.png`) });
  }
});
