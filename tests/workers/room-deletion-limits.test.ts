// Task 21: the room resource caps. The 8MiB content, 20-game and 12-hour
// limits refuse the NEXT game start only — nothing is ever truncated,
// deleted or killed mid-flight; the refusal points the host at closing
// the room and opening a fresh one.
import { afterEach, expect, test } from "vitest";
import { injectRoomLimitsForTest } from "../../apps/server/src/rooms/limits";
import { execSql, namedRoom, NOW } from "./room-helpers";
import { LIVE, restoreDefaultDeps } from "./budget-helpers";
import { setupRoom, Sock, type Joined } from "./ws-helpers";
import { roomStubOf } from "./room-deletion-helpers";

afterEach(() => {
  restoreDefaultDeps();
  injectRoomLimitsForTest(null);
});

test("failure: the 8MiB content cap refuses the next start without truncating", async () => {
  const { room, joins } = await setupRoom(2);
  const stub = roomStubOf(room.roomId);
  const host = await Sock.connect(room.roomId, (joins[0] as Joined).sessionToken);

  // Seed content past a tiny injected cap — the events table already holds
  // presence rows; one fat payload pushes the room over.
  await execSql(
    stub,
    "INSERT INTO events (seq, type, payload) VALUES (?, ?, ?)",
    9_999,
    "fat",
    "x".repeat(5_000),
  );
  const before = await execSql(stub, "SELECT COUNT(*) AS n FROM events");
  injectRoomLimitsForTest({ maxContentBytes: 100 });

  host.sendCmd(room.roomId, "cap-start", "startGame", { mode: "live", seed: 3 });
  const err = await host.next((e) => e.type === "error" && e.payload.code === "room-cap-content");
  if (err.type !== "error") throw new Error("expected an error frame");
  expect(err.payload.commandId).toBe("cap-start");

  // Nothing was truncated or removed — every persisted row survived.
  const after = await execSql(stub, "SELECT COUNT(*) AS n FROM events");
  expect(after[0]?.n).toBe(before[0]?.n);
  const fat = await execSql(stub, "SELECT LENGTH(payload) AS n FROM events WHERE seq = 9999");
  expect(fat[0]?.n).toBe(5_000);
  host.close();
});

test("failure: the 20-game and 12-hour caps refuse the next game start", async () => {
  // Games cap: a room that already finished its maximum refuses create.
  const gamesRoom = namedRoom("cap-games").stub;
  await execSql(
    gamesRoom,
    "INSERT INTO room_lifetime (id, games_finished, evaluation) VALUES (1, 2, 0)",
  );
  injectRoomLimitsForTest({ maxGames: 2 });
  await expect(
    gamesRoom.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW }),
  ).rejects.toThrow(/room-cap-games/);
  expect((await execSql(gamesRoom, "SELECT COUNT(*) AS n FROM room_meta"))[0]?.n).toBe(0);

  // Lifetime cap: a room born before the window refuses create.
  const lifeRoom = namedRoom("cap-life").stub;
  await lifeRoom.initRoom({ inviteSecretHash: "h", platform: "browser", nowMs: 1_000 });
  injectRoomLimitsForTest({ maxLifetimeMs: 1_000 });
  await expect(
    lifeRoom.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW }),
  ).rejects.toThrow(/room-cap-lifetime/);
  // The pre-existing rows are untouched — caps never delete content.
  const auth = await execSql(lifeRoom, "SELECT created_at_ms AS c FROM room_auth WHERE id = 1");
  expect(auth[0]?.c).toBe(1_000);
});
