// The room-create transaction body: game roster rows, the base meta row,
// the `create` action and the immediate `start` action — one commit, so a
// room is never half-initialized. When an invite hash is supplied it is
// stored alongside (an existing invite row is never overwritten).
import type { CreateRoomInit } from "./api";
import { ensureRoomAuth } from "./auth-storage";
import { spentSlotCount } from "./generation-slots";
import { markEvaluationRoom } from "./limits";
import { ROOM_SCHEMA_VERSION } from "./schema";
import {
  type CommitOutcome,
  commitAction,
  insertPlayers,
  maxEventSeq,
  type MetaRow,
} from "./storage";

export const commitCreate = (sql: SqlStorage, init: CreateRoomInit): CommitOutcome => {
  if (init.evaluation === true) markEvaluationRoom(sql);
  if (init.inviteSecretHash !== undefined) {
    ensureRoomAuth(sql, init.inviteSecretHash, init.platform ?? "browser", init.nowMs);
  }
  insertPlayers(sql, init.playerIds, init.platform ?? "browser");
  // Invariant: a live game always has committed eval content. The lobby
  // flow writes the row on the first member join, so this INSERT is a
  // no-op there; the direct-create seam (tests, API provisioning) skips
  // the lobby entirely and would otherwise leave decision jobs with an
  // empty scenario/choice set.
  sql.exec(
    "INSERT OR IGNORE INTO lobby (id, revision, scenario, choices, ready, committed_count) " +
      "VALUES (1, 0, ?, ?, '[]', ?)",
    "なにかが起きている。",
    JSON.stringify(init.playerIds.map((_, i) => ({ choiceId: `c${i}`, label: `選択肢${i + 1}` }))),
    init.playerIds.length,
  );
  const base: MetaRow = {
    schemaVersion: ROOM_SCHEMA_VERSION,
    gameEpoch: 1,
    inputSeq: 0,
    // The events table may already hold room-lifetime rows (lobby
    // presenceChanged / hostChanged): the shared counter continues so the
    // first game event can never collide with them.
    stateRevision: maxEventSeq(sql),
    phase: "lobby",
    snapshot: "null",
    settings: "{}",
    jevAttempts: 0,
    // Task 25: a "pre" slot spent in the lobby predates this meta row —
    // seed the game's visible counter from the slot ledger so the spend
    // stays counted once the game exists.
    generationAttempts: spentSlotCount(sql),
    createdAtMs: init.nowMs,
  };
  const created = commitAction(sql, base, null, {
    type: "create",
    settings: init.settings,
    playerIds: init.playerIds,
    nowMs: init.nowMs,
  });
  return commitAction(sql, created.meta, created.state, {
    type: "start",
    nowMs: init.nowMs,
  });
};
