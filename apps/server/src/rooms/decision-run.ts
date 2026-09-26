// Single-job execution for the decision runner (Task 22): reserve ->
// durable send boundary -> upstream fetch -> commit. Everything in here is
// driven by runDecisionJobs (decision-jobs.ts); the ledger commits live in
// decision-commit.ts.
//
// Ordering contract: the row moves pending -> reserved while a ControlPlane
// grant is held, then the SAME transactionSync that re-checks the game
// state marks it "sent" (bumping tries and jev_attempts) — that commit is
// the honest send boundary. A crash after it is a consumed attempt, never
// a resend; a grant that never reached it gets `release`d.
import { canRetryBeforeDeadline, isRetriableStatus, retryAfterMs } from "@yuragoo/ai";
import {
  createDecisionEnvelope,
  type DecisionEnvelope,
  type DecisionResult,
  parseJevDecisionResponse,
} from "@yuragoo/protocol";
import { latencyBucket, logEvent } from "../observability";
import {
  type AiJobRow,
  attemptToken,
  findAiJob,
  markAiJobSent,
  MAX_JOB_TRIES,
  setAiJobState,
} from "./ai-jobs";
import { utcDay } from "../control/budgets";
import { buildDecisionState } from "./decision-content";
import { writeMeta } from "./storage";
import {
  commitEvaluated,
  failJob,
  failJobRow,
  maybeSettle,
  setJobState,
  sleep,
} from "./decision-commit";
import {
  type DecisionJobDeps,
  type DecisionJobHost,
  type JobBudget,
  JEV_ORDINARY_CAP,
  JEV_PER_GAME_CAP,
  JOB_WINDOW_MS,
  SEND_TIMEOUT_MS,
} from "./decision-jobs";

export type JobOutcome = "done" | "failed" | "pending";
type Deps = DecisionJobDeps & { readonly control: JobBudget };
type SendVerdict = "send" | "release" | "skip";

// The durable send boundary — the ONLY place an attempt becomes a send.
// Re-derives the gate from live books, so a rematch/phase flip between
// reserve and send can never sneak an extra send past the cap.
const sendBoundary = (host: DecisionJobHost, job: AiJobRow): SendVerdict =>
  host.txn((): SendVerdict => {
    const cur = findAiJob(host.sql, job.token);
    const b = host.booksView();
    if (cur === null || cur.state !== "reserved" || b === null) return "skip";
    const p = b.state.posts.find((x) => x.postId === job.token);
    if (p === undefined || b.state.phase === "lobby" || b.state.phase === "finished") {
      failJobRow(host.sql, job.token, "gone");
      return "release"; // provably never sent
    }
    if (p.status !== "pending") {
      setAiJobState(host.sql, job.token, "done");
      return "release";
    }
    const k = b.state.phase === "complete" ? "jev-final" : "jev";
    if (b.meta.jevAttempts >= (k === "jev" ? JEV_ORDINARY_CAP : JEV_PER_GAME_CAP)) {
      setAiJobState(host.sql, job.token, "pending");
      return "release";
    }
    markAiJobSent(host.sql, job.token);
    writeMeta(host.sql, { ...b.meta, jevAttempts: b.meta.jevAttempts + 1 });
    return "send";
  });

const callUpstream = async (
  deps: Deps,
  envelope: DecisionEnvelope,
  sendDeadline: number,
): Promise<{ result: DecisionResult | null; retriable: boolean; delayMs: number }> => {
  const controller = new AbortController();
  const sentAt = deps.nowMs();
  const timer = setTimeout(
    () => controller.abort(new DOMException("deadline", "TimeoutError")),
    Math.max(1, sendDeadline - deps.nowMs()),
  );
  try {
    const response = await deps.fetch(deps.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.apiKey}`,
      },
      body: JSON.stringify(envelope.body),
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) {
      try {
        const result = parseJevDecisionResponse(await response.json(), envelope);
        logEvent({
          eventCode: "jev-decision",
          modelVersion: result.model,
          latencyBucket: latencyBucket(deps.nowMs() - sentAt),
          usage: result.usage,
        });
        return { result, retriable: false, delayMs: 0 };
      } catch {
        logEvent({
          eventCode: "jev-decision",
          errorKind: "invalid-response",
          latencyBucket: latencyBucket(deps.nowMs() - sentAt),
        });
        return { result: null, retriable: false, delayMs: 0 }; // contract violation never retries
      }
    }
    logEvent({
      eventCode: "jev-decision",
      errorKind: `http-${response.status}`,
      latencyBucket: latencyBucket(deps.nowMs() - sentAt),
    });
    return {
      result: null,
      retriable: isRetriableStatus(response.status),
      delayMs: retryAfterMs(response.headers.get("retry-after"), deps.nowMs()),
    };
  } catch {
    const ek = controller.signal.aborted ? "timeout" : "transport";
    logEvent({
      eventCode: "jev-decision",
      errorKind: ek,
      latencyBucket: latencyBucket(deps.nowMs() - sentAt),
    });
    return { result: null, retriable: true, delayMs: 0 }; // transport failure / deadline abort
  } finally {
    clearTimeout(timer);
  }
};

export const runOneJob = async (
  host: DecisionJobHost,
  deps: Deps,
  job: AiJobRow,
): Promise<JobOutcome> => {
  const books = host.booksView();
  if (books === null) return "failed";
  const post = books.state.posts.find((p) => p.postId === job.token);
  const phase = books.state.phase;
  if (post === undefined || phase === "lobby" || phase === "finished") {
    failJob(host, job.token, "gone");
    return "failed";
  }
  if (post.status !== "pending") {
    setJobState(host, job.token, "done");
    return "done";
  }
  const kind = phase === "complete" ? "jev-final" : "jev";
  // Per-game gate (atomically re-checked at the send boundary): ordinary
  // jobs share slots 1..118 of 120; the last two are settle-only. A denied
  // job stays pending — never terminal — it may still take a final slot.
  const cap = kind === "jev" ? JEV_ORDINARY_CAP : JEV_PER_GAME_CAP;
  if (books.meta.jevAttempts >= cap) return "pending";
  const settleAt = books.state.settleDeadlineAtMs;
  const jobDeadline =
    phase === "complete" && settleAt !== null
      ? Math.min(settleAt, deps.nowMs() + JOB_WINDOW_MS)
      : deps.nowMs() + JOB_WINDOW_MS;
  if (deps.nowMs() >= jobDeadline) {
    failJob(host, job.token, "expired");
    return "failed";
  }
  let envelope: DecisionEnvelope;
  try {
    envelope = createDecisionEnvelope(
      buildDecisionState(host.sql, books.state, post),
      deps.nowMs(),
    );
  } catch {
    failJob(host, job.token, "envelope");
    return "failed";
  }
  const token = attemptToken(host.roomId, books.meta.gameEpoch, job.token, job.tries + 1);
  let grant: { ok: boolean };
  try {
    grant = await deps.control.reserve({
      roomId: host.roomId,
      token,
      kind,
      day: utcDay(deps.nowMs()),
    });
  } catch {
    failJob(host, job.token, "budget-down"); // budget service down -> deny
    return "failed";
  }
  if (!grant.ok) {
    failJob(host, job.token, "cap"); // daily-cap/config: never retried
    return "failed";
  }
  // Grant held -> "reserved" persists before the send boundary.
  const reserved = host.txn(() => {
    const cur = findAiJob(host.sql, job.token);
    if (cur === null || cur.state !== "pending" || cur.tries !== job.tries) return false;
    setAiJobState(host.sql, job.token, "reserved");
    return true;
  });
  if (!reserved) {
    await deps.control.release({ token }).catch(() => {});
    return "pending";
  }
  const verdict = sendBoundary(host, job);
  if (verdict === "release") {
    await deps.control.release({ token }).catch(() => {});
    return "pending";
  }
  if (verdict !== "send") return "pending";
  const b2 = host.booksView();
  if (b2 !== null) {
    host.setBooks({ meta: { ...b2.meta, jevAttempts: b2.meta.jevAttempts + 1 }, state: b2.state });
  }
  const sendDeadline = Math.min(deps.nowMs() + SEND_TIMEOUT_MS, jobDeadline);
  const out = await callUpstream(deps, envelope, sendDeadline);
  // The attempt is consumed no matter what happened on the wire.
  if (out.result !== null) {
    commitEvaluated(host, job, out.result, deps.nowMs());
    await deps.control.consume({ token }).catch(() => {});
    maybeSettle(host, deps);
    return "done";
  }
  const triesNow = job.tries + 1;
  const retry =
    out.retriable &&
    triesNow < MAX_JOB_TRIES &&
    canRetryBeforeDeadline(deps.nowMs(), out.delayMs, jobDeadline);
  host.txn(() => {
    if (retry) setAiJobState(host.sql, job.token, "pending");
    else failJobRow(host.sql, job.token, "upstream");
  });
  await deps.control.consume({ token }).catch(() => {});
  if (retry) {
    await sleep(out.delayMs);
    return runOneJob(host, deps, { ...job, tries: triesNow });
  }
  return "failed";
};
