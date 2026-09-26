// Task 39 release gate, failure lane: a member's network dies mid-game.
// The RoomConnection retry lane rotates credentials and re-admits; the
// fresh snapshot rebuilds the room view with the roster intact and the
// current turn reflected — and the healed page can act through its own
// dock again. Same topology as the happy spec: vite preview proxy plus
// the :8791 Jev fixture the worker's bindings already point at.
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  actTurn,
  armContent,
  copyInvite,
  createViaHome,
  joinViaLink,
  pickAndSee,
  readyStart,
  turnOwner,
} from "../lobby/full-flow-helpers";
import { waitMemberCount } from "../lobby/helpers";
import { type JevFixture, startJevFixture } from "../rooms/mp-fixture";

const contexts: BrowserContext[] = [];
let jev: JevFixture;
test.beforeAll(async () => {
  jev = await startJevFixture();
});
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
test.afterAll(async () => {
  await jev?.close();
});

test("failure: mid-game offline drop heals by snapshot — roster and turn intact", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const host = await createViaHome(browser, contexts, "hb=250");
  const invite = await copyInvite(host);
  const member = await joinViaLink(browser, contexts, invite, "メンバー");
  await waitMemberCount(host, 2);
  const all = [host, member];
  await armContent(host, member, 2);
  await pickAndSee(host, member, "2"); // 2 rounds -> 4 turns
  await readyStart(all);
  await expect(member.getByTestId("creature-stage")).toBeVisible({ timeout: 20_000 });

  // Walk the real dock until the HOST owns the turn — the member must
  // not be mid-turn when its network drops (alternating turns make this
  // at most one extra post).
  for (let i = 0; i < 4 && (await turnOwner(all)) !== host; i += 1) {
    await actTurn(all, "post", "まえのこえ");
  }
  expect(await turnOwner(all)).toBe(host);

  // Cut the member's network; the host's post still lands (and its turn
  // moves on) while the member's page is frozen on the stale snapshot.
  await member.context().setOffline(true);
  await actTurn(all, "post", "くらやみをてらす");
  await member.waitForTimeout(900); // past the 800ms presence lease
  await member.context().setOffline(false);

  // Re-admission pushes a fresh snapshot: the dock still stands, the
  // roster seats both players, and it is now the member's own turn —
  // a state the frozen page could not have rendered on its own.
  await member.getByTestId("room-dock").waitFor({ timeout: 30_000 });
  await expect(member.getByTestId("roster-chip")).toHaveCount(2, { timeout: 30_000 });
  await member.locator("[data-turn-self]").waitFor({ timeout: 30_000 });

  // The wire is live again: the healed page posts through its own dock
  // and the host's page watches the turn move.
  await actTurn(all, "post", "つなぎなおしたこえ");
});
