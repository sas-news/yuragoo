// Server-authoritative early decision (Task 26): watches every committed
// evaluated distribution for SUSTAINED dominance and closes gameplay
// through the normal reducer path — adhere, then dwell-complete — so the
// earlyDecision flag, phase, pending-post and TURN-round gates stay the
// final word. Client-reported adherence is never read: the streak is
// derived only from persisted ai_results.
//
// The streak lives in the `early_watch` row (dominant slot + honest clock
// start) and a `dwell` deadline row — persisted, so an evicted DO
// reconstructs it exactly and pause/resume parking covers it for free.
import { GameRuleError } from "@yuragoo/game-core";
import type { DecisionDistribution } from "@yuragoo/protocol";
import { deleteDeadlineIds, replaceDeadline } from "./deadlines";
import type { Books } from "./due";
import { commitAction } from "./storage";

// The contract's dominance window: top probability >= 0.75 and
// top-vs-runner-up margin >= 0.20, sustained for settings.adhesionSeconds.
export const EARLY_TOP_MIN = 0.75;
export const EARLY_MARGIN_MIN = 0.2;
export const EARLY_WATCH_TAG = "dwell";
const EPS = 1e-9;

interface WatchRow {
  readonly slot: number;
  readonly sinceMs: number;
}

// Dominant slot under the contract window, or null. A single-choice
// distribution is dominant by definition once it clears the top bar.
export const dominanceSlot = (dist: readonly DecisionDistribution[]): number | null => {
  if (dist.length === 0) return null;
  let top = 0;
  let second = -1;
  for (let i = 1; i < dist.length; i += 1) {
    const p = dist[i]?.probability ?? 0;
    if (p > (dist[top]?.probability ?? 0)) {
      second = top;
      top = i;
    } else if (second < 0 || p > (dist[second]?.probability ?? 0)) {
      second = i;
    }
  }
  const topP = dist[top]?.probability ?? 0;
  const margin = topP - (second < 0 ? 0 : (dist[second]?.probability ?? 0));
  return topP + EPS >= EARLY_TOP_MIN && margin + EPS >= EARLY_MARGIN_MIN ? top : null;
};

export const readEarlyWatch = (sql: SqlStorage): WatchRow | null => {
  const row = sql
    .exec<{ slot: number; since_ms: number }>("SELECT slot, since_ms FROM early_watch WHERE id = 1")
    .toArray()[0];
  return row === undefined ? null : { slot: row.slot, sinceMs: row.since_ms };
};

export const clearEarlyWatch = (sql: SqlStorage): void => {
  sql.exec("DELETE FROM early_watch");
  deleteDeadlineIds(sql, [EARLY_WATCH_TAG]);
};

const writeEarlyWatch = (sql: SqlStorage, slot: number, sinceMs: number): void => {
  sql.exec(
    "INSERT OR REPLACE INTO early_watch (id, slot, since_ms) VALUES (1, ?, ?)",
    slot,
    sinceMs,
  );
};

// Whether the match can even entertain an early end: the flag, the phase
// and TURN's one-full-round fairness floor (round 0 = first round still
// in progress — nobody has had all their turns yet).
const watchable = (books: Books): boolean =>
  books.state.settings.earlyDecision === true &&
  books.state.phase === "playing" &&
  !(books.state.settings.mode === "turn" && books.state.round === 0);

// A post accepted after the streak began breaks the sustain — its pending
// evaluation may reverse the leader (the contract's reset rule).
const postAfter = (books: Books, sinceMs: number): boolean =>
  books.state.posts.some((p) => p.postedAtMs > sinceMs);

// Called inside commitEvaluated's txn with the just-landed distribution:
// update the streak, re-arm the dwell clock and report the adhesion via
// the normal action path (the reducer gates stay authoritative — a
// rejection here is expected racing behaviour, never an error).
export const trackEvaluated = (
  sql: SqlStorage,
  books: Books,
  dist: readonly DecisionDistribution[],
  nowMs: number,
): Books => {
  const slot = watchable(books) ? dominanceSlot(dist) : null;
  if (slot === null) {
    clearEarlyWatch(sql);
    return books;
  }
  const cur = readEarlyWatch(sql);
  const stale = cur === null || cur.slot !== slot || postAfter(books, cur.sinceMs);
  const sinceMs = stale ? nowMs : cur.sinceMs;
  if (stale) writeEarlyWatch(sql, slot, sinceMs);
  // Re-arm unconditionally: a dwell row may have been consumed by a
  // blocked fire (a pending post) — the next dominant eval restores the
  // honest clock at the SAME sinceMs.
  replaceDeadline(
    sql,
    EARLY_WATCH_TAG,
    sinceMs + books.state.settings.adhesionSeconds * 1000,
    EARLY_WATCH_TAG,
  );
  if (!stale) return books;
  try {
    const committed = commitAction(sql, books.meta, books.state, {
      type: "adhere",
      slot,
      nowMs,
    });
    return { meta: committed.meta, state: committed.state };
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
    return books;
  }
};

// A dwell deadline fired (the row was already consumed by the caller):
// re-check the whole contract — flag, phase, hold time, zero pending and
// no newer post — then dispatch dwell-complete through the normal action
// path. Runs inside the alarm's transactionSync.
export const fireEarlyWatch = (sql: SqlStorage, books: Books, nowMs: number): Books => {
  const cur = readEarlyWatch(sql);
  if (cur === null) return books;
  if (!watchable(books) || postAfter(books, cur.sinceMs)) {
    // The streak is provably over — a phase flip or a newer post reset it.
    clearEarlyWatch(sql);
    return books;
  }
  if (
    nowMs - cur.sinceMs < books.state.settings.adhesionSeconds * 1000 ||
    books.state.posts.some((p) => p.status === "pending")
  ) {
    // Clock not held out / a pending post blocks the close — keep the
    // streak; the next dominant eval re-arms the same clock.
    return books;
  }
  try {
    const committed = commitAction(sql, books.meta, books.state, {
      type: "dwell-complete",
      nowMs,
    });
    clearEarlyWatch(sql);
    return { meta: committed.meta, state: committed.state };
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
    return books;
  }
};
