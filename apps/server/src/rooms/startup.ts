// Constructor-side startup work (Tasks 19-22), split out of GameRoom.ts
// so the class file stays under the handwritten-size cap. The constructor
// only recovers persisted state and delegates here — an empty database
// still never becomes a room. Ordering: re-arm a missed alarm first, then
// the closed/expired guards, then live-room recovery (outbox + job drive).
import type { ServerBindings } from "../config";
import { hasPendingOutbox } from "./aggregate-outbox";
import { minDeadlineRunAt } from "./deadlines";
import { scheduleJobRecovery, type DecisionJobHost } from "./decision-jobs";
import { isRoomExpired } from "./leases";
import type { Recovery } from "./recovery";

// The GameRoom surface the startup pass needs (DecisionJobHost covers
// sql/txn/booksView/setBooks/broadcast for the job-recovery leg).
export interface StartupHost extends DecisionJobHost {
  isClosed(): boolean;
  emptyGraceMs(): number;
  rearm(): Promise<void>;
  retireRoom(): Promise<void>;
  retryWipe(): Promise<void>;
  driveOutbox(): Promise<void>;
  driveDecisionJobs(): Promise<void>;
  driveEnding(): Promise<void>;
}

export const runStartup = (
  host: StartupHost,
  ctx: Pick<DurableObjectState, "waitUntil" | "storage">,
  env: ServerBindings,
  recovered: Recovery,
): void => {
  // A missed alarm must be re-armed after eviction, but an existing one
  // is never overwritten — it already covers whatever fired while away.
  if (minDeadlineRunAt(host.sql) !== null) {
    ctx.waitUntil(
      ctx.storage.getAlarm().then(async (a) => {
        if (a === null) await host.rearm();
      }),
    );
  }
  if (host.isClosed()) {
    // The wipe was interrupted by an eviction/restart — finish it now.
    if (recovered.kind === "closed" && recovered.deletionPending) {
      ctx.waitUntil(host.retryWipe().catch(() => {}));
    }
    return;
  }
  // Expired purge on startup: a room whose empty-grace window elapsed
  // while evicted is deleted now (covers game and lobby-only rooms
  // alike), not whenever an alarm next lands.
  if (isRoomExpired(host.sql, host.emptyGraceMs(), Date.now())) {
    ctx.waitUntil(host.retireRoom().catch(() => {}));
    return;
  }
  const books = host.booksView();
  if (books !== null) {
    // A pending aggregate submission survives eviction for as long as
    // the room itself lives.
    if (hasPendingOutbox(host.sql)) {
      ctx.waitUntil(host.driveOutbox().catch(() => {}));
    }
    // Task 22 recovery: suppress orphaned jobs (never resend) + re-drive
    // survivors — inside waitUntil, never blocking on ControlPlane.
    scheduleJobRecovery(ctx, host, env, books.meta.gameEpoch);
    // Task 32: a DO evicted between finish and the ending write (or the
    // post-game generation send boundary) resumes here — kickEnding is
    // idempotent on the ending row and the "post" slot.
    if (books.state.phase === "finished") {
      ctx.waitUntil(host.driveEnding().catch(() => {}));
    }
  }
};
