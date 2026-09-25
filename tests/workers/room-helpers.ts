// Shared fixtures and DO-context probes for the GameRoom storage tests.
// Every probe runs through runInDurableObject so reads happen inside the
// real object's storage context, exactly like post-eviction recovery does.
import { env, runInDurableObject } from "cloudflare:test";
import type { GameRoom } from "../../apps/server/src/rooms/GameRoom";
import { listDeadlines } from "../../apps/server/src/rooms/deadlines";
import { findCommand, listEvents } from "../../apps/server/src/rooms/storage";

export type RoomStub = DurableObjectStub<GameRoom>;
export const NOW = 1_800_000_000_000;

export const TURN_SETTINGS = {
  mode: "turn",
  seed: 7,
  rosterSize: 2,
  turnSeconds: 20,
  rounds: 2,
} as const;

export const LIVE_SETTINGS = {
  mode: "live",
  seed: 7,
  rosterSize: 2,
  liveSeconds: 120,
  // Task 26: fixtures exercise the ENABLED host-decision path — the
  // request-end tests spread this and would gate out under the default.
  hostDecision: true,
} as const;

let counter = 0;

// A unique room per call — DO storage persists across tests in one
// miniflare run, so names must never be reused.
export const namedRoom = (label: string): { stub: RoomStub; id: DurableObjectId } => {
  const id = env.GAME_ROOM.idFromName(`${label}-${counter}`);
  counter += 1;
  return { stub: env.GAME_ROOM.get(id), id };
};

export const roomStub = (label: string): RoomStub => namedRoom(label).stub;

export const must = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
};

// Raw SQL escape hatch for seeding/poisoning rows in failure tests.
export const execSql = (
  stub: RoomStub,
  query: string,
  ...params: (string | number | null)[]
): Promise<Record<string, SqlStorageValue>[]> =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec(query, ...params).toArray());

export const readAlarm = (stub: RoomStub): Promise<number | null> =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm());

export const setAlarm = (stub: RoomStub, atMs: number): Promise<void> =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.setAlarm(atMs));

export const eventRows = (stub: RoomStub) =>
  runInDurableObject(stub, (_i, ctx) => listEvents(ctx.storage.sql));

export const deadlineRows = (stub: RoomStub) =>
  runInDurableObject(stub, (_i, ctx) => listDeadlines(ctx.storage.sql));

export const commandRow = (stub: RoomStub, playerId: string, commandId: string) =>
  runInDurableObject(stub, (_i, ctx) => findCommand(ctx.storage.sql, playerId, commandId));

// Delivers alarm() directly on the instance — a duplicated delivery,
// regardless of whether an alarm is currently scheduled.
export const deliverAlarm = (stub: RoomStub): Promise<void> =>
  runInDurableObject(stub, (instance) => instance.alarm());
