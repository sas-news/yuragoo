// Commit-side helpers for runClientCommand (./commands), split out so that
// file stays under the handwritten-size cap. Everything here is the "how a
// plan lands" half: dedupe rows, create+start / rematch commits, ack-only
// writes and the persisted roomClosed row. Identity checks happened
// upstream in ./dispatch.planFor.
import type { GameSettings } from "@yuragoo/game-core";
import { rearmOutboxDeadline } from "./aggregate-outbox";
import { clearGameArtifacts } from "./ai-jobs";
import { RoomError } from "./api";
import type { CommandHost, CommandOutcome } from "./commands";
import { commitCreate } from "./create";
import type { Plan } from "./dispatch";
import type { Books } from "./due";
import { rearmLeaseSweep } from "./leases";
import {
  type ApplyResult,
  type CommitOutcome,
  commitAction,
  type DedupeKey,
  findCommand,
  insertCommand,
  insertPlayers,
  type MetaRow,
  recordRoomEvent,
} from "./storage";
import { CommandError, eventFrames, frame } from "./wire";
import { commitLobbyStart } from "./lobby";
import { executeLobbyPlan } from "./lobby-commit";

const insertDedupe = (host: CommandHost, d: DedupeKey, r: ApplyResult): void =>
  insertCommand(host.sql, d.playerId, d.commandId, d.fingerprint, JSON.stringify(r));

// Dedupe lookup shared by WS commands and apply(): null = first delivery,
// ApplyResult = stored-ack replay, RoomError = payload conflict.
export const replayedAck = (
  host: { readonly sql: SqlStorage },
  playerId: string,
  commandId: string,
  fingerprint: string,
): ApplyResult | null => {
  const existing = findCommand(host.sql, playerId, commandId);
  if (existing === null) return null;
  if (existing.fingerprint !== fingerprint) {
    throw new RoomError("idempotency-conflict", "commandId was already used differently");
  }
  return JSON.parse(existing.ack) as ApplyResult;
};

// Non-reducer commands (heartbeat, updateLobby, closeRoom): the write and
// a synthetic dedupe row commit together; a null key (heartbeat) skips it.
const commitAckOnly = (
  host: CommandHost,
  dedupe: DedupeKey | null,
  write: () => void,
): ApplyResult => {
  const books = host.booksView();
  const rev = books?.meta.stateRevision ?? 0;
  const result: ApplyResult = {
    ack: { accepted: true, inputSeq: books?.meta.inputSeq ?? 0, stateRevision: rev },
    events: [],
    stateRevision: rev,
  };
  host.txn(() => {
    write();
    if (dedupe !== null) insertDedupe(host, dedupe, result);
  });
  return result;
};

// create+start in one commit (startGame on an empty room); dedupe row too.
const commitCreateStart = (
  host: CommandHost,
  settings: GameSettings,
  playerIds: readonly string[],
  dedupe: DedupeKey | null,
): CommitOutcome => {
  const committed = host.txn(() => {
    const out = commitCreate(host.sql, {
      settings,
      playerIds,
      nowMs: Date.now(),
      platform: "browser",
    });
    // Task 24: the game takes the first `memberCount` lobby choices as its
    // committed set; the orphan tail stays in the ledger for later games.
    // No lobbyChanged row here: snapshots read committed_count straight
    // from the ledger, and clients derive the live count from the game
    // state's rosterSize — an extra room row would only shift seqs.
    commitLobbyStart(host.sql, playerIds.length);
    if (dedupe !== null) insertDedupe(host, dedupe, out.result);
    return out;
  });
  host.setBooks({ meta: committed.meta, state: committed.state });
  return committed;
};

// Rematch writes a new generation (epoch+1) on a null state; stale
// roster/deadline/job rows are cleared in the same commit.
const commitRematch = (
  host: CommandHost,
  books: Books,
  dedupe: DedupeKey | null,
): CommitOutcome => {
  const committed = host.txn(() => {
    // Task 22: per-game attempt counters restart with the new epoch.
    const meta: MetaRow = {
      ...books.meta,
      gameEpoch: books.meta.gameEpoch + 1,
      jevAttempts: 0,
      generationAttempts: 0,
    };
    const settings = books.state.settings;
    const playerIds = books.state.roster.map((p) => p.id);
    host.sql.exec("DELETE FROM players");
    host.sql.exec("DELETE FROM deadlines");
    clearGameArtifacts(host.sql); // jobs + landed results + spent slots
    // The wipe also took the lease-sweep bookkeeping row — re-arm it for
    // the live leases so the room's single alarm still covers them.
    rearmLeaseSweep(host.sql);
    // And any armed aggregate-outbox flush row: pending submissions live
    // independently of the game epoch and keep their own retry clock.
    rearmOutboxDeadline(host.sql);
    insertPlayers(host.sql, playerIds, "browser");
    const created = commitAction(host.sql, meta, null, {
      type: "create",
      settings,
      playerIds,
      nowMs: Date.now(),
    });
    const out = commitAction(host.sql, created.meta, created.state, {
      type: "start",
      nowMs: Date.now(),
    });
    if (dedupe !== null) insertDedupe(host, dedupe, out.result);
    return out;
  });
  host.setBooks({ meta: committed.meta, state: committed.state });
  return committed;
};

const requireBooks = (books: Books | null): Books => {
  if (books === null) throw new CommandError("not-created", "no game exists in this room yet");
  return books;
};

const finishCommit = (host: CommandHost, committed: CommitOutcome) => ({
  result: committed.result,
  events: eventFrames(host, committed.result, committed.state),
  committed: true,
  closeRoom: false,
  dropPlayerIds: [] as readonly string[],
});

export const executePlan = (
  host: CommandHost,
  plan: Plan,
  dedupe: DedupeKey | null,
): Omit<CommandOutcome, "ack" | "reply"> & { result: ApplyResult } => {
  switch (plan.kind) {
    case "action": {
      const b = requireBooks(host.booksView());
      // null-dedupe can't reach here — heartbeat is always ack-only.
      const committed = host.txn(() =>
        commitAction(host.sql, b.meta, b.state, plan.action, dedupe ?? undefined),
      );
      host.setBooks({ meta: committed.meta, state: committed.state });
      return finishCommit(host, committed);
    }
    case "create-start": {
      const committed = commitCreateStart(host, plan.settings, plan.playerIds, dedupe);
      host.registerRoom();
      return finishCommit(host, committed);
    }
    case "rematch": {
      const committed = commitRematch(host, requireBooks(host.booksView()), dedupe);
      host.registerRoom();
      return finishCommit(host, committed);
    }
    case "ack-only": {
      const result = commitAckOnly(host, dedupe, () => plan.write(host.sql));
      return { result, events: [], committed: false, closeRoom: false, dropPlayerIds: [] };
    }
    case "close": {
      // roomClosed is a persisted ledger row — its seq keeps the stream gap-free.
      let seq = 0;
      const result = commitAckOnly(host, dedupe, () => {
        seq = recordRoomEvent(host.sql, "roomClosed", { reason: "host-closed" });
      });
      // The row advanced state_revision — re-sync the in-memory counter.
      const b = host.booksView();
      if (b !== null) host.setBooks({ ...b, meta: { ...b.meta, stateRevision: seq } });
      const closed = frame(host, seq, seq, "roomClosed", { reason: "host-closed" });
      return { result, events: [closed], committed: false, closeRoom: true, dropPlayerIds: [] };
    }
    case "lobby-content":
    case "lobby-ready":
    case "lobby-settings":
    case "leave":
    case "back-to-lobby":
    case "transfer-host":
    case "generate-choices":
    case "generate-scenario": {
      // Task 24/25/44 plans land through the lobby executor (./lobby-commit).
      return executeLobbyPlan(host, plan, dedupe);
    }
  }
};
