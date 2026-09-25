// DecisionLab E2E (mock path only — no worker is started here): proves the
// staged 自由投稿→Jev→生命体 flow: synchronous anticipation lean held for the
// minimum dwell, pending, a visible 葛藤 dwell on knife-edge distributions,
// distribution-matched deformation, failure recovery and stale discards.
import { expect, test } from "@playwright/test";
import {
  CONFLICT_DWELL_MS,
  decisionPose,
  dominantNear,
  flowState,
  flowStatusIs,
  MIN_ANTICIPATION_MS,
  setFailNext,
  setMockDelay,
  setMockScenarioKey,
  SLOT_ANGLES_4,
  submitPost,
  waitDecisionReady,
} from "./helpers";

test("loads: stage ready, mock badge, and no secret-capable input", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await expect(page.getByTestId("provider-badge")).toHaveText("mock");
  await expect(page.getByTestId("provider-mock")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("flow-status")).toHaveAttribute("data-status", "idle");
  const inputs = page.locator("input");
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    const type = ((await input.getAttribute("type")) ?? "").toLowerCase();
    const named =
      `${await input.getAttribute("name")} ${await input.getAttribute("id")} ` +
      `${await input.getAttribute("data-testid")} ${await input.getAttribute("autocomplete")}`;
    expect(type).not.toBe("password");
    expect(named.toLowerCase()).not.toMatch(/password|secret|token|api[-_]?key/);
  }
});

test("happy: submit flows pending→resolved, anticipation <80ms, a-dominant", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await setMockDelay(page, 400);
  await page.getByTestId("advocate-a").click();
  await page.getByTestId("post-text").fill("プリンがいいです");
  await page.getByTestId("post-submit").click();
  // Ordered transitions: pending is observed before resolved.
  await flowStatusIs(page, "pending");
  await flowStatusIs(page, "resolved");
  const snap = await flowState(page);
  expect(snap?.status).toBe("resolved");
  expect(snap?.anticipationMs ?? 999).toBeLessThan(80);
  expect(snap?.anticipationMs ?? -1).toBeGreaterThanOrEqual(0);
  const result = page.getByTestId("last-result");
  await expect(result).toContainText("jev-1.13.0");
  await expect(result).toContainText("mock");
  await expect(result).toContainText("→○A");
  // The deformation follows the returned distribution: dominant angle is a's.
  await dominantNear(page, SLOT_ANGLES_4[0] ?? 0);
  const pose = await decisionPose(page);
  expect(pose?.expression).toBe("engaged");
  expect(pose?.dominance ?? 0).toBeGreaterThan(0.4);
  expect(pose?.gaze.y ?? 0).toBeLessThan(-0.8);
});

test("failure: forced error keeps prior pose, alerts, and re-enables submit", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await setFailNext(page, "quota");
  await submitPost(page, "ゼリーにしてみよう", "c");
  await flowStatusIs(page, "failed");
  await expect(page.getByRole("alert")).toContainText("評価に失敗しました: quota");
  await expect(page.getByTestId("post-submit")).toBeEnabled();
  await expect.poll(async () => (await decisionPose(page))?.expression).toBe("rest");
  // Recovery: the next submission runs the flow again.
  await submitPost(page, "やっぱりプリン", "a");
  await flowStatusIs(page, "resolved");
  await expect(page.getByTestId("last-result")).toContainText("→○A");
});

test("happy: a stale result is discarded — only the newer submit applies", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await setMockDelay(page, 500);
  void submitPost(page, "プリン派です", "a");
  await page.waitForTimeout(60);
  void submitPost(page, "おむすび派です", "b");
  await flowStatusIs(page, "resolved", 6000);
  await expect(page.getByTestId("last-result")).toContainText("→◇B");
  // After settling the pose favors b's direction (canonical index 1 → 0 rad).
  await dominantNear(page, SLOT_ANGLES_4[1] ?? 0);
  const pose = await decisionPose(page);
  expect(pose?.dominance ?? 0).toBeGreaterThan(0.4);
});

test("live: gateway provider issues a real fetch and fails unreachable", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await page.getByTestId("provider-live").click();
  await expect(page.getByTestId("provider-badge")).toHaveText("live gateway");
  await expect(page.getByTestId("gateway-url")).toHaveValue("http://127.0.0.1:8787");
  // Task 20's room worker now serves :8787 during e2e — point the live
  // probe at a guaranteed-dead port so it still proves a real fetch fails.
  await page.getByTestId("gateway-url").fill("http://127.0.0.1:9");
  await submitPost(page, "プリンがいいです", "a");
  await flowStatusIs(page, "failed", 15000);
  await expect(page.getByRole("alert")).toContainText(/unreachable|timeout/);
  const snap = await flowState(page);
  expect(snap?.lastSource).not.toBe("live");
});

test("happy: context and revision grow across three submissions", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  for (const text of ["一つ目の投稿", "二つ目の投稿", "三つ目の投稿"]) {
    await submitPost(page, text, "a");
    await flowStatusIs(page, "resolved");
  }
  const snap = await flowState(page);
  expect(snap?.revision).toBe(3);
  expect(snap?.contextSize).toBe(3);
  await expect(page.getByTestId("context-log").locator("li")).toHaveCount(3);
});

test("conflict: a contested result dwells in まよってる before resolving", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await setMockScenarioKey(page, "contest");
  // Not awaited: submit() resolves only after the full staged flow, which
  // would miss the conflicted window entirely.
  void submitPost(page, "どっちも捨てがたい", "a");
  // The knife-edge distribution detours through the conflicted stage.
  await flowStatusIs(page, "conflicted");
  await expect(page.getByTestId("flow-status")).toContainText("まよってる");
  // During the dwell the pose is a two-lobe split, not a committed direction:
  // dominance (= max - second) collapses toward zero, expression stays hesitant.
  const torn = await decisionPose(page);
  expect(torn?.expression).toBe("hesitating");
  expect(torn?.dominance ?? 1).toBeLessThan(0.15);
  await flowStatusIs(page, "resolved");
  const snap = await flowState(page);
  // The 葛藤 beat lasted roughly the dwell (timer slack allowed).
  expect((snap?.resolvedAt ?? 0) - (snap?.conflictedAt ?? 0)).toBeGreaterThanOrEqual(
    CONFLICT_DWELL_MS - 50,
  );
  const pose = await decisionPose(page);
  expect(pose?.expression).toBe("engaged");
  // The committed distribution is still a genuine coin flip between a and b.
  expect(pose?.dominance ?? 1).toBeLessThan(0.15);
  await expect(page.getByTestId("last-result")).toContainText(/→[○◇][AB]/);
  await setMockScenarioKey(page); // restore the default favor-* scenarios
});

test("dwell: an instant mock still holds anticipation ≥ MIN_ANTICIPATION_MS", async ({ page }) => {
  await page.goto("/dev/decision");
  await waitDecisionReady(page);
  await setMockDelay(page, 0);
  await submitPost(page, "プリン一択です", "a");
  await flowStatusIs(page, "resolved");
  const snap = await flowState(page);
  // resolvedAt is measured from the submit timestamp inside the page.
  expect(snap?.resolvedAt ?? 0).toBeGreaterThanOrEqual(MIN_ANTICIPATION_MS - 5);
  // No conflict on the confident favor-a path — speed contrast is the point.
  expect(snap?.conflictedAt ?? 1).toBe(0);
  const pose = await decisionPose(page);
  expect(pose?.expression).toBe("engaged");
  await dominantNear(page, SLOT_ANGLES_4[0] ?? 0);
});
