// Alarm handling + timer-driven event broadcast (Tasks 19-21). The room's
// single alarm is min(deadlines.run_at); due rows split into room
// bookkeeping tags (lease-sweep / room-expiry / room-purge / wipe-retry /
// outbox-flush) and game clocks (turn/match/settle, fired through the same
// atomic commit as apply(), minus dedupe). Task 21 additions: expiry now
// arms the purge row instead of just closing sockets, the purge row runs
// the real delete, an outbox tag drives the aggregate flush, and a closed
// room's alarm only services the deleteAll retry.
import { deleteDeadlineIds, dueDeadlines, replaceDeadline } from "./deadlines";
import { fireDueDeadlines } from "./due";
import { EARLY_WATCH_TAG, fireEarlyWatch } from "./early-watch";
import {
  LEASE_SWEEP_TAG,
  OUTBOX_FLUSH_TAG,
  readPresence,
  ROOM_DEADLINE_TAGS,
  ROOM_EXPIRY_TAG,
  ROOM_PURGE_TAG,
  VACATE_TAG,
} from "./leases";
import { Acc, markExpired, sweepExpiredLeases } from "./presence";
import { fireVacateDeadlines } from "./presence-vacate";
import { maxEventSeq } from "./storage";
import { attachmentOf, broadcastNewEvents, type SocketAttachment } from "./wire";
import type { SocketHost } from "./transport";

export const handleAlarm = async (host: SocketHost): Promise<void> => {
  if (host.isClosed()) {
    // Closed rooms keep exactly one alarm reason: the deleteAll retry.
    // retryWipe is a no-op once the tombstone says "done".
    await host.retryWipe();
    return;
  }
  const nowMs = Date.now();
  const since = maxEventSeq(host.sql);
  const books = host.booksView();
  let sweptIds: string[] = [];
  let booksUpdate = null as null | NonNullable<typeof books>;
  let expiredNow = false;
  let purgeNow = false;
  let flushWanted = false;
  let sweepSeq: number | null = null;
  host.storage().transactionSync(() => {
    const due = dueDeadlines(host.sql, nowMs);
    const dueTags = new Set(due.map((d) => d.tag));
    const vacateDue = due.filter((d) => d.tag === VACATE_TAG);
    if (vacateDue.length > 0) {
      deleteDeadlineIds(
        host.sql,
        vacateDue.map((d) => d.id),
      );
      const acc = new Acc();
      fireVacateDeadlines(host, vacateDue, nowMs, acc);
      const out = acc.done();
      sweptIds = [...sweptIds, ...out.expiredIds];
      sweepSeq = out.lastEventSeq ?? sweepSeq;
      if (out.books !== null) booksUpdate = out.books;
    }
    if (dueTags.has(LEASE_SWEEP_TAG)) {
      deleteDeadlineIds(host.sql, [LEASE_SWEEP_TAG]);
      const out = sweepExpiredLeases(host, nowMs);
      sweptIds = [...sweptIds, ...out.expiredIds];
      sweepSeq = out.lastEventSeq ?? sweepSeq;
      if (out.books !== null) booksUpdate = out.books;
    }
    if (dueTags.has(ROOM_PURGE_TAG)) {
      // Grace ended earlier; the purge row now runs the real delete.
      deleteDeadlineIds(host.sql, [ROOM_PURGE_TAG]);
      purgeNow = true;
    }
    if (dueTags.has(ROOM_EXPIRY_TAG)) {
      deleteDeadlineIds(host.sql, [ROOM_EXPIRY_TAG]);
      // The row only exists while the room is empty; a resume deletes it,
      // so reaching here means the grace window really did pass. Mark
      // expired and arm the purge — the actual delete is the next alarm.
      markExpired(host);
      replaceDeadline(host.sql, ROOM_PURGE_TAG, nowMs + host.purgeDelayMs(), ROOM_PURGE_TAG);
      expiredNow = true;
    }
    if (dueTags.has(OUTBOX_FLUSH_TAG)) {
      deleteDeadlineIds(host.sql, [OUTBOX_FLUSH_TAG]);
      flushWanted = true;
    }
    // Re-query inside the commit: the sweep above may have just parked the
    // playing clocks (room went empty), which must never still fire.
    if (books !== null && !purgeNow) {
      const gameDue = dueDeadlines(host.sql, nowMs).filter((d) => !ROOM_DEADLINE_TAGS.has(d.tag));
      // Task 26: the early-watch dwell clock is not a reducer deadline —
      // it re-checks the persisted streak and dispatches through the
      // normal action path. Normal game clocks fire first so a racing
      // turn/match/settle boundary always wins the single settle entry.
      const dwellDue = gameDue.filter((d) => d.tag === EARLY_WATCH_TAG);
      const normalDue = gameDue.filter((d) => d.tag !== EARLY_WATCH_TAG);
      if (normalDue.length > 0 || dwellDue.length > 0) {
        // The sweep's room rows advanced the events head — the meta handed
        // to commitAction must sit at the real head or it collides.
        const base = booksUpdate ?? books;
        const head = maxEventSeq(host.sql);
        const synced =
          base.meta.stateRevision === head
            ? base
            : { meta: { ...base.meta, stateRevision: head }, state: base.state };
        let cur = synced;
        if (normalDue.length > 0) cur = fireDueDeadlines(host.sql, cur, normalDue);
        for (const row of dwellDue) {
          deleteDeadlineIds(host.sql, [row.id]);
          cur = fireEarlyWatch(host.sql, cur, Math.max(nowMs, row.runAt));
        }
        booksUpdate = cur;
      }
    }
  });
  // Publish the new books whenever the commit advanced the ledger: fired
  // game events return fresh meta, while a sweep with no game fire still
  // advanced the revision through its room-event rows.
  if (booksUpdate !== null) {
    const seq = Math.max(booksUpdate.meta.stateRevision, sweepSeq ?? 0);
    host.setBooks({
      meta: { ...booksUpdate.meta, stateRevision: seq },
      state: booksUpdate.state,
    });
  } else if (books !== null && (sweepSeq ?? 0) > books.meta.stateRevision) {
    host.setBooks({
      meta: { ...books.meta, stateRevision: sweepSeq ?? books.meta.stateRevision },
      state: books.state,
    });
  }
  // Terminal purge: revoke + invalidate + socket close + deleteAll live in
  // the retire path; broadcasts are moot once storage is going away.
  if (purgeNow) {
    await host.retireRoom();
    return;
  }
  broadcastNewEvents(host, since, (booksUpdate ?? books)?.state ?? null);
  closeIds(host, sweptIds);
  if (expiredNow || readPresence(host.sql).expired) {
    // Terminal: every remaining socket is stale past the grace window.
    for (const ws of host.sockets()) {
      try {
        ws.close(1000, "room-expired");
      } catch {
        // Already closing.
      }
    }
  }
  await host.rearm();
  // A finished game enqueued the aggregate outbox (or a flush row came
  // due) — drive it off the alarm path.
  if (flushWanted || (booksUpdate ?? books)?.state.phase === "finished") {
    host.waitUntil(host.driveOutbox());
    host.waitUntil(host.driveEnding());
  }
  // Deadline transitions can open the settle window (final evaluations)
  // or leave jobs stranded by an eviction — drive the runner without
  // blocking the alarm path.
  host.waitUntil(host.driveDecisionJobs());
};

const closeIds = (host: SocketHost, playerIds: readonly string[]): void => {
  if (playerIds.length === 0) return;
  const ids = new Set(playerIds);
  for (const ws of host.sockets()) {
    const att: SocketAttachment | null = attachmentOf(ws);
    if (att !== null && ids.has(att.playerId)) {
      try {
        ws.close(1000, "lease-expired");
      } catch {
        // Already closing.
      }
    }
  }
};
