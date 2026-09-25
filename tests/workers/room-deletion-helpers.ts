// Shared helpers for the Task-21 room-deletion test files (split for the
// 250-line handwritten cap): the data-table wipe assert, stub lookup,
// JSON POSTs, a deterministic one-winner game and the tombstone read.
import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { execSql, NOW, type RoomStub } from "./room-helpers";
import { drive, post } from "./budget-helpers";
import { BASE, GOOD_ORIGIN } from "./ws-helpers";

// Every table that may hold room data — the tombstone is the only row
// allowed to outlive a close.
export const DATA_TABLES = [
  "room_meta",
  "players",
  "commands",
  "events",
  "deadlines",
  "ai_jobs",
  "ai_results",
  "early_watch",
  "generation_slots",
  "ending",
  "room_auth",
  "room_players",
  "lobby_settings",
  "ws_tickets",
  "room_presence",
  "paused_deadlines",
  "outbox",
  "room_lifetime",
] as const;

export const assertWiped = async (stub: RoomStub): Promise<void> => {
  for (const table of DATA_TABLES) {
    const rows = await execSql(stub, `SELECT COUNT(*) AS n FROM ${table}`);
    expect(rows[0]?.n, `${table} must be empty`).toBe(0);
  }
  const tomb = await execSql(stub, "SELECT wipe_state AS s FROM room_tombstone WHERE id = 1");
  expect(tomb[0]?.s, "room_tombstone must say done").toBe("done");
};

export const roomStubOf = (roomId: string): RoomStub =>
  env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));

export const postJson = (path: string, body: unknown): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: JSON.stringify(body),
  });

// One completed LIVE game with a winner: post -> evaluate -> request-end
// -> host settle claim inside the window. Deterministic game clock (NOW),
// duration lands at exactly NOW+4000 - NOW = 4000ms.
export const finishWinner = async (stub: RoomStub, tag: string): Promise<void> => {
  await post(stub, "p1", 0, NOW + 1_000);
  await drive(stub);
  const snap = await stub.snapshot();
  if (snap.state.posts[0]?.status !== "evaluated") {
    throw new Error("post was not evaluated — upstream stub did not land");
  }
  await stub.apply({
    playerId: "p1",
    commandId: `end-${tag}`,
    fingerprint: `fpe-${tag}`,
    action: { type: "request-end", playerId: "p1", nowMs: NOW + 2_000 },
  });
  await stub.apply({
    playerId: "p1",
    commandId: `settle-${tag}`,
    fingerprint: `fps-${tag}`,
    action: { type: "settle", nowMs: NOW + 4_000, claim: { kind: "winner", slot: 0 } },
  });
};

export const tombstoneState = async (stub: RoomStub): Promise<string | null> =>
  ((await execSql(stub, "SELECT wipe_state AS s FROM room_tombstone WHERE id = 1"))[0]?.s as
    | string
    | undefined) ?? null;
