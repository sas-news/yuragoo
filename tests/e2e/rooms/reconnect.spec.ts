// Task 20 e2e: the browser client against the real wrangler dev worker —
// heartbeats hold the compressed lease, an offline drop rotates credentials
// and re-admits inside the empty grace window, and roomClosed stops the
// retry loop for good. All traffic goes through window.__roomBridge, which
// only exists in the e2e build mode.
import { expect, test } from "@playwright/test";
import type { RoomBridge } from "../../../apps/web/src/net/room-bridge";

declare global {
  interface Window {
    __roomBridge?: RoomBridge;
  }
}

type Page = import("@playwright/test").Page;

// Evaluated code cannot see Node constants — every page-side value is
// either a literal inside the callback or arrives through evaluate's arg.
const gotoBridge = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.waitForFunction(() => window.__roomBridge !== undefined);
};

const makeRoom = (page: Page) =>
  page.evaluate(async () => {
    const b = window.__roomBridge;
    if (b === undefined) throw new Error("bridge missing");
    const room = await b.createRoom("");
    const auth = await b.join("", room.roomId, room.inviteSecret, "え2e");
    return { roomId: room.roomId, auth };
  });

const connectAuto = (page: Page, id: string, roomId: string, auth: unknown) =>
  page.evaluate(
    async ({ roomId: rid, auth: a, clientId }) => {
      await window.__roomBridge?.connectAuto(clientId, {
        origin: "",
        roomId: rid,
        credentials: a as never,
        heartbeatMs: 250, // lease is 800ms in the dev bindings
        backoff: { initialMs: 50, maxMs: 200, seed: 3 },
      });
    },
    { roomId, auth, clientId: id },
  );

test("happy: heartbeats hold the lease; an offline drop rotates and re-admits", async ({
  page,
  context,
}) => {
  await gotoBridge(page);
  const { roomId, auth } = await makeRoom(page);
  await connectAuto(page, "a", roomId, auth);
  await page.waitForFunction(() => window.__roomBridge?.clients.a?.snapshot !== null);
  // 1.2s > 800ms lease: only the 250ms heartbeats keep presence alive —
  // no disconnect frame may appear for this player meanwhile.
  await page.waitForTimeout(1_200);
  const drops = await page.evaluate(
    (playerId) =>
      (window.__roomBridge?.clients.a?.events ?? []).filter(
        (e) =>
          e.type === "presenceChanged" &&
          e.payload.playerId === playerId &&
          e.payload.connected === false,
      ).length,
    auth.playerId,
  );
  expect(drops).toBe(0);
  // Cut the network: the socket drops, the retry lane sleeps+rotates, and
  // the 1500ms empty-grace window outlives this offline stretch.
  await context.setOffline(true);
  await page.waitForTimeout(700);
  await context.setOffline(false);
  await page.waitForFunction(() => (window.__roomBridge?.clients.a?.reconnects ?? 0) >= 1, null, {
    timeout: 10_000,
  });
  // Re-admission pushed a fresh snapshot: the player is connected again.
  const connected = await page.evaluate(
    (playerId) =>
      window.__roomBridge?.clients.a?.snapshot?.players.find((p) => p.playerId === playerId)
        ?.connected,
    auth.playerId,
  );
  expect(connected).toBe(true);
});

test("roomClosed ends the retry loop: no re-admission, no more sockets", async ({ page }) => {
  await gotoBridge(page);
  const { roomId, auth } = await makeRoom(page);
  await connectAuto(page, "a", roomId, auth);
  await page.waitForFunction(() => window.__roomBridge?.clients.a?.snapshot !== null);
  // The (only) connected player is host: its closeRoom tears the room down.
  const ack = await page.evaluate(async () => {
    const env = (await window.__roomBridge?.send("a", "closeRoom")) as { type: string } | undefined;
    return env?.type ?? "missing";
  });
  expect(ack).toBe("ack");
  await page.waitForFunction(() => window.__roomBridge?.clients.a?.closed !== null);
  const sawClosed = await page.evaluate(
    () =>
      (window.__roomBridge?.clients.a?.events ?? []).some((e) => e.type === "roomClosed") ||
      (window.__roomBridge?.clients.a?.frames ?? []).some((e) => e.type === "roomClosed"),
  );
  expect(sawClosed).toBe(true);
  // Terminal: wait well past the compressed grace window — no re-admission.
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(() => window.__roomBridge?.clients.a?.reconnects)).toBe(0);
});
