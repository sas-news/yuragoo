// Task 44 gate: AI お題 generation end to end — the host's one-shot
// button hits the generation fixture, the proposal plate lands, and
// applying it pushes the scenario to every member's read view through
// the normal revision-gated lobby write. Never a real model call: the
// worker's GENERATION_UPSTREAM_URL points at the local fixture.
import { expect, test, type BrowserContext } from "@playwright/test";
import { seat } from "./full-flow-helpers";
import { type GenerationFixture, startGenerationFixture } from "./gen-fixture";
import { createRoom, waitMemberCount, waitScenarioOn } from "./helpers";

const contexts: BrowserContext[] = [];
let gen: GenerationFixture;
test.beforeAll(async () => {
  gen = await startGenerationFixture();
});
test.afterEach(async () => {
  gen.mode = "ok";
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  await gen?.close();
});

test("happy: AI お題 proposal applies and reaches the member", async ({ browser }) => {
  test.setTimeout(90_000);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  // Host-only affordance: the member's read view never renders it.
  await expect(member.getByTestId("scenario-generate")).toHaveCount(0);
  const requestsBefore = gen.requests.length;
  await host.getByTestId("scenario-generate").click();
  const proposal = host.locator("[data-proposal-scenario]");
  await expect(proposal).toHaveText("雨の日のピクニック大作戦", { timeout: 20_000 });
  expect(gen.requests.length).toBe(requestsBefore + 1); // one send per click
  // The click burned the slot — the button stays disabled after landing.
  await expect(host.getByTestId("scenario-generate")).toBeDisabled();
  // Apply rides the ordinary revision-gated lobby write: members converge.
  await host.getByTestId("scenario-proposal-apply").click();
  await waitScenarioOn(member, "雨の日のピクニック大作戦");
  await expect(host.locator("textarea")).toHaveValue("雨の日のピクニック大作戦");
});

test("failure: a garbage upstream burns the slot with a scoped error", async ({ browser }) => {
  test.setTimeout(90_000);
  gen.mode = "garbage";
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  await waitMemberCount(host, 1);
  await host.getByTestId("scenario-generate").click();
  // The failure event surfaces as the shared generation-error line, and
  // the spent slot keeps the button disabled — no silent retry.
  await expect(host.getByText(/生成に失敗/)).toBeVisible({ timeout: 20_000 });
  await expect(host.getByTestId("scenario-generate")).toBeDisabled();
});
