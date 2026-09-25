// The Task 26 host settings patch, split out of ./lobby for the size cap.
// The sanitized merge decides whether anything changed: a true no-op is
// ack-only (no revision bump, no ready reset), while a real change writes
// the patch, bumps the revision and clears EVERY ready flag in the same
// transaction — nobody can stay readied across a settings switch they
// never saw.
import type { LobbySettings, LobbyState } from "@yuragoo/protocol";
import { commitLobby, readLobby } from "./lobby";
import { mergeLobbyPatch, writeLobbyPatch } from "./settings";

export const applyLobbySettings = (sql: SqlStorage, patch: LobbySettings): LobbyState | null => {
  const merged = mergeLobbyPatch(sql, patch);
  if (merged === null) return null;
  writeLobbyPatch(sql, merged);
  const lobby = readLobby(sql);
  const state = { ...lobby, revision: lobby.revision + 1, ready: [] };
  commitLobby(sql, state);
  return state;
};
