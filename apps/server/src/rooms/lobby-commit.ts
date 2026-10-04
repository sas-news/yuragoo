// Commit-side execution for the Task 24 lobby plans (lobby-content /
// lobby-ready / leave), split out of commits.ts for the size cap. Same
// atomic pattern as every other command: ledger writes + event rows +
// the dedupe row inside one transactionSync, then ack/event frames built
// from exactly what committed. backToLobby/transferHost live in
// lifecycle-commit.ts; the shared outcome shape lives in lobby-outcome.ts.
import type { LobbyState, ServerEnvelope } from "@yuragoo/protocol";
import { deleteRoomPlayer, writeLease } from "./auth-storage";
import type { CommandHost } from "./commands";
import type { Books } from "./due";
import type { Plan } from "./dispatch";
import { applyHostElection } from "./host-election";
import { deleteDeadlineIds, replaceDeadline } from "./deadlines";
import {
  connectedPlayerIds,
  LEASE_SWEEP_TAG,
  pausePlayingDeadlines,
  readPresence,
  rearmLeaseSweep,
  ROOM_EXPIRY_TAG,
  writePresence,
} from "./leases";
import { executeLifecyclePlan } from "./lifecycle-commit";
import { applyLobbyContent, applySetReady, onMemberLeft } from "./lobby";
import { applyLobbySettings } from "./lobby-settings";
import { type LobbyPlanOutcome, ackResult } from "./lobby-outcome";
import {
  type ApplyResult,
  type DedupeKey,
  type EventRow,
  insertCommand,
  maxEventSeq,
} from "./storage";
import { eventRowEnvelope, frame } from "./wire";

// Content edits and ready flips share one shape: the op writes the lobby
// row plus a lobbyChanged event row (or nothing, for a redundant ready),
// then the ack and the broadcast frame carry the resulting state.
const commitLobbyWrite = (
  host: CommandHost,
  dedupe: DedupeKey | null,
  run: (sql: SqlStorage) => LobbyState | null,
): LobbyPlanOutcome => {
  let state: LobbyState | null = null;
  const result = host.txn(() => {
    state = run(host.sql);
    const seq = maxEventSeq(host.sql);
    const result: ApplyResult = ackResult(host, seq);
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
  const revision = result.stateRevision;
  const events = state === null ? [] : [frame(host, revision, revision, "lobbyChanged", state)];
  return { result, events, committed: false, closeRoom: false, dropPlayerIds: [] };
};

// `leave`: the membership row dies with its tokens, the memberLeft +
// lobbyChanged rows persist in the shared seq space, the host seat
// re-elects when needed, and the empty-room bookkeeping mirrors a
// disconnect (grace clock + parked playing clocks). The leaver's sockets
// close AFTER their ack lands — the caller drops them post-deliver.
const commitLeave = (
  host: CommandHost,
  playerId: string,
  dedupe: DedupeKey | null,
): LobbyPlanOutcome => {
  const since = maxEventSeq(host.sql);
  let election: Books | null = null;
  const result = host.txn(() => {
    const books = host.booksView();
    const nowMs = Date.now();
    writeLease(host.sql, playerId, null);
    // onMemberLeft needs the row alive: the seat index is the leaver's
    // join_order rank, so their choice draft can move to the orphan tail.
    onMemberLeft(host.sql, playerId, books !== null);
    deleteRoomPlayer(host.sql, playerId);
    if (connectedPlayerIds(host.sql, nowMs).size === 0) {
      const presence = readPresence(host.sql);
      const pause = books?.state.phase === "playing";
      writePresence(host.sql, {
        ...presence,
        emptySinceMs: nowMs,
        pausedAtMs: pause ? nowMs : null,
      });
      if (pause) pausePlayingDeadlines(host.sql, nowMs);
      deleteDeadlineIds(host.sql, [LEASE_SWEEP_TAG]);
      replaceDeadline(host.sql, ROOM_EXPIRY_TAG, nowMs + host.emptyGraceMs(), ROOM_EXPIRY_TAG);
    } else {
      rearmLeaseSweep(host.sql);
      const el = applyHostElection(host.sql, books, nowMs);
      if (el.books !== null) election = el.books;
    }
    const result = ackResult(host, maxEventSeq(host.sql));
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
  // The room rows advanced the shared seq head — re-sync the in-memory
  // meta (with the election's books swap riding along) exactly like
  // commitPresence does, or the next game commit re-uses an events.seq.
  const books = election ?? host.booksView();
  if (books !== null) {
    host.setBooks({
      meta: { ...books.meta, stateRevision: result.stateRevision },
      state: books.state,
    });
  }
  const revision = maxEventSeq(host.sql);
  const events = host.sql
    .exec<EventRow>("SELECT seq, type, payload FROM events WHERE seq > ? ORDER BY seq", since)
    .toArray()
    .map((row) => eventRowEnvelope(host, row, books?.state ?? null, revision))
    .filter((e): e is ServerEnvelope => e !== null);
  return { result, events, committed: true, closeRoom: false, dropPlayerIds: [playerId] };
};

// `generate-choices` (Task 25): the commit is
// only the dedupe row — the slot spend, daily reserve and provider call
// are all async work kicked afterwards so a rejected request can never
// reach the provider. The outcome arrives later as *Generated /
// generationFailed events.
const commitGenerationRequest = (
  host: CommandHost,
  kick: () => void,
  dedupe: DedupeKey | null,
): LobbyPlanOutcome => {
  const result = host.txn(() => {
    const r = ackResult(host, maxEventSeq(host.sql));
    if (dedupe !== null) {
      insertCommand(
        host.sql,
        dedupe.playerId,
        dedupe.commandId,
        dedupe.fingerprint,
        JSON.stringify(r),
      );
    }
    return r;
  });
  kick();
  return { result, events: [], committed: false, closeRoom: false, dropPlayerIds: [] };
};

export const executeLobbyPlan = (
  host: CommandHost,
  plan: Plan,
  dedupe: DedupeKey | null,
): LobbyPlanOutcome => {
  switch (plan.kind) {
    case "lobby-content":
      return commitLobbyWrite(host, dedupe, (sql) => applyLobbyContent(sql, plan.payload));
    case "lobby-ready":
      return commitLobbyWrite(host, dedupe, (sql) => applySetReady(sql, plan.playerId, plan.ready));
    case "lobby-settings":
      // Task 26: the merge decides — a true no-op is ack-only, a real
      // change clears every ready flag in the same commit.
      return commitLobbyWrite(host, dedupe, (sql) => applyLobbySettings(sql, plan.payload));
    case "leave":
      return commitLeave(host, plan.playerId, dedupe);
    case "back-to-lobby":
    case "transfer-host":
      return executeLifecyclePlan(host, plan, dedupe);
    case "generate-choices":
      return commitGenerationRequest(host, () => host.startChoiceGeneration(plan.request), dedupe);
    default:
      throw new Error(`not a lobby plan: ${plan.kind}`);
  }
};
