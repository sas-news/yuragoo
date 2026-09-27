// The Task 26 host settings patch, split out of ./lobby for the size cap.
// The sanitized merge decides whether anything changed: a true no-op is
// ack-only (no revision bump, no ready reset), while a real change writes
// the patch and bumps the revision. Ready flags are cleared ONLY when the
// effective mode field moved — turn/live is the one switch that changes
// what a member is agreeing to; knobs like turnSeconds leave them intact.
import type { LobbySettings, LobbyState } from "@yuragoo/protocol";
import { commitLobby, readLobby } from "./lobby";
import { lobbySettingsView, mergeLobbyPatch, readLobbyPatch, writeLobbyPatch } from "./settings";

export const applyLobbySettings = (sql: SqlStorage, patch: LobbySettings): LobbyState | null => {
  // The stored patch is read before the merge — mergeLobbyPatch never
  // writes, so this is the "before" mode for the ready-reset comparison.
  const beforeMode = lobbySettingsView(readLobbyPatch(sql)).mode;
  const merged = mergeLobbyPatch(sql, patch);
  if (merged === null) return null;
  const modeChanged = lobbySettingsView(merged).mode !== beforeMode;
  writeLobbyPatch(sql, merged);
  const lobby = readLobby(sql);
  const state = {
    ...lobby,
    revision: lobby.revision + 1,
    ready: modeChanged ? [] : lobby.ready,
  };
  commitLobby(sql, state);
  return state;
};
