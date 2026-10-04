// Commit-side execution for the game<->lobby lifecycle plans
// (backToLobby / transferHost), split out of lobby-commit.ts for the
// size cap. Same atomic pattern: ledger writes + event rows + the dedupe
// row inside one transactionSync, then frames built from committed state.
import type { LobbyState, ServerEnvelope } from "@yuragoo/protocol";
import { clearGameArtifacts } from "./ai-jobs";
import { rearmOutboxDeadline } from "./aggregate-outbox";
import { deleteRoomPlayer, listRoomPlayers } from "./auth-storage";
import type { CommandHost } from "./commands";
import type { Plan } from "./dispatch";
import { applyHostTransfer } from "./host-election";
import { rearmLeaseSweep } from "./leases";
import { activeMemberCount, onMemberLeft, readLobby } from "./lobby";
import { type LobbyPlanOutcome, ackResult } from "./lobby-outcome";
import {
  type DedupeKey,
  type EventRow,
  insertCommand,
  maxEventSeq,
  recordRoomEvent,
} from "./storage";
import { eventRowEnvelope, frame } from "./wire";

// `backToLobby`: a finished game returns to the shared lobby instead of
// auto-restarting — the game ledger (roster/deadlines/jobs/results/spent
// slots AND the room_meta row) dies in one commit, leaving exactly the
// persisted shape of a never-started room. lobby-waiting joiners promote
// to full members and their missing choice rows grow in, ready flags
// reset (fresh consent for the next start), and one persisted
// lobbyReopened row flips every client's view back. Recovery reads the
// meta-less room via room_auth — a "null" snapshot would be corruption.
const commitBackToLobby = (host: CommandHost, dedupe: DedupeKey | null): LobbyPlanOutcome => {
  const since = maxEventSeq(host.sql);
  const result = host.txn(() => {
    host.sql.exec("DELETE FROM players");
    host.sql.exec("DELETE FROM deadlines");
    clearGameArtifacts(host.sql); // jobs + landed results + spent slots
    rearmLeaseSweep(host.sql); // the wipe took the sweep row — re-arm it
    rearmOutboxDeadline(host.sql); // pending aggregate submissions survive
    host.sql.exec("UPDATE room_players SET lobby_waiting = 0");
    // Ghost sweep: members who dropped mid-game were kept for reconnect,
    // but the room is a lobby again — their seats release like any lobby
    // exit (memberLeft + ready strip + draft to the orphan tail).
    const nowMs = Date.now();
    for (const p of listRoomPlayers(host.sql)) {
      // Never-connected invite holders (generation 0) are members, not
      // ghosts — only a socket that connected and then dropped vacates.
      const ghost = p.socketGeneration > 0 && (p.leaseUntilMs === null || p.leaseUntilMs <= nowMs);
      if (!ghost) continue;
      onMemberLeft(host.sql, p.playerId, false);
      deleteRoomPlayer(host.sql, p.playerId);
    }
    const lobby = readLobby(host.sql);
    // Mid-game joiners never grew a choice row — fill seats for everyone.
    const count = activeMemberCount(host.sql);
    const choices = [...lobby.choices];
    while (choices.length < count) choices.push({ choiceId: `c${choices.length}`, label: "" });
    const reopened: LobbyState = {
      ...lobby,
      revision: lobby.revision + 1,
      ready: [],
      committedCount: 0,
      choices,
    };
    host.sql.exec(
      "INSERT OR REPLACE INTO lobby (id, revision, scenario, choices, ready, committed_count) " +
        "VALUES (1, ?, ?, ?, '[]', 0)",
      reopened.revision,
      reopened.scenario,
      JSON.stringify(choices),
    );
    const seq = recordRoomEvent(host.sql, "lobbyReopened", reopened);
    host.sql.exec("DELETE FROM room_meta"); // meta is born at game create
    const result = ackResult(host, seq);
    if (dedupe !== null) {
      insertCommand(
        host.sql,
        dedupe.playerId,
        dedupe.commandId,
        dedupe.fingerprint,
        JSON.stringify(result),
      );
    }
    return result;
  });
  host.setBooks(null); // the game ledger is gone — the room is a lobby again
  const revision = maxEventSeq(host.sql);
  // Deliver every persisted row — ghost-sweep memberLeft/lobbyChanged
  // events precede the lobbyReopened frame in the same seq stream.
  const events = host.sql
    .exec<EventRow>("SELECT seq, type, payload FROM events WHERE seq > ? ORDER BY seq", since)
    .toArray()
    .map((row) => eventRowEnvelope(host, row, null, revision))
    .filter((e): e is ServerEnvelope => e !== null);
  // committed: the deadline wipe + re-arms must reach the alarm scheduler.
  return { result, events, committed: true, closeRoom: false, dropPlayerIds: [] };
};

// `transferHost`: explicit hand-off — same commit shape as an election
// (presence row + hostChanged event + in-game hostId retarget).
const commitTransferHost = (
  host: CommandHost,
  targetId: string,
  dedupe: DedupeKey | null,
): LobbyPlanOutcome => {
  const result = host.txn(() => {
    const el = applyHostTransfer(host.sql, host.booksView(), targetId);
    if (el.books !== null) host.setBooks(el.books);
    const result = ackResult(host, el.eventSeq ?? maxEventSeq(host.sql));
    if (dedupe !== null) {
      insertCommand(
        host.sql,
        dedupe.playerId,
        dedupe.commandId,
        dedupe.fingerprint,
        JSON.stringify(result),
      );
    }
    return result;
  });
  // The hostChanged row advanced the shared seq head — re-sync meta or
  // the next game commit re-uses the seq (same rule as commitLeave).
  const b = host.booksView();
  if (b !== null) {
    host.setBooks({ meta: { ...b.meta, stateRevision: result.stateRevision }, state: b.state });
  }
  const revision = result.stateRevision;
  const events = [frame(host, revision, revision, "hostChanged", { playerId: targetId })];
  return { result, events, committed: false, closeRoom: false, dropPlayerIds: [] };
};

export const executeLifecyclePlan = (
  host: CommandHost,
  plan: Plan,
  dedupe: DedupeKey | null,
): LobbyPlanOutcome => {
  switch (plan.kind) {
    case "back-to-lobby":
      return commitBackToLobby(host, dedupe);
    case "transfer-host":
      return commitTransferHost(host, plan.targetId, dedupe);
    default:
      throw new Error(`not a lifecycle plan: ${plan.kind}`);
  }
};
