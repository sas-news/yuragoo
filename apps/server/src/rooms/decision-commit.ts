// Ledger commits for the decision runner (Task 22): the evaluated action,
// the persisted decisionUpdated event row and the room-side settle once the
// cutoff is fully evaluated. Driven by decision-run.ts; every write happens
// inside a host.txn so a crash can never half-commit a result.
import { GameRuleError, type GameState, type SettleClaim } from "@yuragoo/game-core";
import type { DecisionDistribution, DecisionResult } from "@yuragoo/protocol";
import { type AiJobRow, findAiJob, insertAiResult, listAiResults, setAiJobState } from "./ai-jobs";
import type { Books } from "./due";
import { trackEvaluated } from "./early-watch";
import { commitAction, maxEventSeq, recordRoomEvent } from "./storage";
import { broadcastNewEvents } from "./wire";
import type { DecisionJobDeps, DecisionJobHost } from "./decision-jobs";

export const setJobState = (host: DecisionJobHost, token: string, state: string): void => {
  host.txn(() => setAiJobState(host.sql, token, state));
};

// Terminal job failure, row + ledger event atomically: a "failed" job is
// never claimed again, so the post stays pending forever — clients need a
// persisted decisionFailed row or the eval just silently never lands.
export const failJobRow = (sql: SqlStorage, token: string, code: string): void => {
  setAiJobState(sql, token, "failed");
  recordRoomEvent(sql, "decisionFailed", { postId: token, code });
};

export const failJob = (host: DecisionJobHost, token: string, code: string): void => {
  host.txn(() => failJobRow(host.sql, token, code));
};

// Room rows advance MAX(events.seq) — the in-memory stateRevision must be
// re-synced or the next commitAction publishes at a colliding seq. Every
// site that writes a decisionFailed row outside a commitAction runs this.
export const syncBooksRevision = (host: DecisionJobHost): void => {
  const b = host.booksView();
  if (b === null) return;
  const rev = maxEventSeq(host.sql);
  if (rev !== b.meta.stateRevision) {
    host.setBooks({ meta: { ...b.meta, stateRevision: rev }, state: b.state });
  }
};

const dominantSlot = (dist: readonly DecisionDistribution[]): number => {
  let best = 0;
  for (let i = 1; i < dist.length; i += 1) {
    if ((dist[i]?.probability ?? 0) > (dist[best]?.probability ?? 0)) best = i;
  }
  return best;
};

// The host claim once the cutoff is fully evaluated: dominant slot of the
// newest landed distribution, else noContest/budget (mirrors local play).
const settleClaimFor = (state: GameState, results: ReadonlyMap<string, string>): SettleClaim => {
  const cutoff = state.settleCutoffSeq ?? state.seq;
  for (let i = state.posts.length - 1; i >= 0; i -= 1) {
    const post = state.posts[i];
    if (post === undefined || post.seq > cutoff || post.status !== "evaluated") continue;
    const raw = results.get(post.postId);
    if (raw === undefined) continue;
    return { kind: "winner", slot: dominantSlot((JSON.parse(raw) as DecisionResult).distribution) };
  }
  return { kind: "noContest", reason: "budget" };
};

// Commit the landed result: evaluated action + ai_results row + a persisted
// decisionUpdated event, atomically, then broadcast the new ledger row.
// Task 26: the early-decision watcher runs in the SAME transaction — the
// landed distribution updates the sustained-dominance streak, re-arms the
// dwell clock and reports the adhesion through the normal action path.
export const commitEvaluated = (
  host: DecisionJobHost,
  job: AiJobRow,
  result: DecisionResult,
  nowMs: number,
): void => {
  const since = maxEventSeq(host.sql);
  let next: Books | null = null;
  host.txn(() => {
    const cur = findAiJob(host.sql, job.token);
    const books = host.booksView();
    if (cur === null || cur.state !== "sent" || books === null) return; // raced/suppressed
    try {
      const committed = commitAction(host.sql, books.meta, books.state, {
        type: "evaluated",
        postId: job.token,
      });
      insertAiResult(host.sql, job.token, JSON.stringify(result));
      const seq = recordRoomEvent(host.sql, "decisionUpdated", {
        postId: job.token,
        revision: result.revision,
        distribution: result.distribution,
      });
      setAiJobState(host.sql, job.token, "done");
      next = trackEvaluated(
        host.sql,
        { meta: { ...committed.meta, stateRevision: seq }, state: committed.state },
        result.distribution,
        nowMs,
      );
    } catch (e) {
      if (e instanceof GameRuleError) {
        failJobRow(host.sql, job.token, "commit");
        return;
      }
      throw e;
    }
  });
  if (next !== null) {
    const b: Books = next;
    host.setBooks(b);
    broadcastNewEvents(host, since, b.state);
  } else {
    // The txn may still have written a decisionFailed row (GameRuleError on
    // the evaluated commit): re-sync the in-memory revision and push the
    // row. Raced/suppressed early-returns wrote nothing — both calls no-op.
    syncBooksRevision(host);
    broadcastNewEvents(host, since, host.booksView()?.state ?? null);
  }
};

// Once the cutoff is fully evaluated the room settles itself: the host
// claim is derived from the stored distributions. A racing settle-deadline
// already fixed the outcome -> GameRuleError is expected and ignored.
// A match with zero posts keeps waiting — its window must expire as
// noContest/timeout, not an instant budget verdict on nothing. The claim
// clock is deps.nowMs so tests pin it like every other job timestamp.
export const maybeSettle = (host: DecisionJobHost, deps: Pick<DecisionJobDeps, "nowMs">): void => {
  const books = host.booksView();
  if (books === null || books.state.phase !== "complete") return;
  if (books.state.posts.length === 0) return;
  const cutoff = books.state.settleCutoffSeq ?? books.state.seq;
  if (books.state.posts.some((p) => p.status === "pending" && p.seq <= cutoff)) return;
  const results = new Map(listAiResults(host.sql).map((r) => [r.postId, r.payload]));
  const claim = settleClaimFor(books.state, results);
  const since = maxEventSeq(host.sql);
  try {
    const committed = host.txn(() =>
      commitAction(host.sql, books.meta, books.state, {
        type: "settle",
        nowMs: deps.nowMs(),
        claim,
      }),
    );
    host.setBooks({ meta: committed.meta, state: committed.state });
    broadcastNewEvents(host, since, committed.state);
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
  }
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
