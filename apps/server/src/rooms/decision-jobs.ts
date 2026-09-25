// Server-authoritative decision-job runner (Task 22): the public surface.
// A "pending" ai_jobs row written by the reducer's evaluate command is
// claimed by runDecisionJobs; decision-run.ts carries one job through
// reserve -> durable send boundary -> upstream fetch -> ledger commit.
//
// At-most-once honesty: a job only becomes a send inside the same
// transactionSync that marks it "sent" (bumping tries and jev_attempts).
// A crash anywhere after that commit leaves a "sent"/"reserved" row that
// recovery suppresses to "failed" and consumes — the upstream call may
// have happened, so it is never re-sent. `release` is only invoked when
// the send provably never became durable.
import { JEV_ENDPOINT, jevOutboundFetch } from "@yuragoo/ai";
import { CONTROL_PLANE_NAME } from "../control/ControlPlane";
import type { ServerBindings } from "../config";
import {
  findAiJob,
  listClaimableJobs,
  MAX_JOB_TRIES,
  suppressedAttemptToken,
  suppressInterruptedJobs,
} from "./ai-jobs";
import type { Books } from "./due";
import { type BroadcastHost, broadcastNewEvents } from "./wire";
import { maxEventSeq, recordRoomEvent } from "./storage";
import { failJobRow, maybeSettle, syncBooksRevision } from "./decision-commit";
import { runOneJob } from "./decision-run";

export const JEV_PER_GAME_CAP = 120;
export const JEV_ORDINARY_CAP = 118; // attempts 119-120 are settle-only
export const SEND_TIMEOUT_MS = 3_000; // one try is 3s (contract)
export const JOB_WINDOW_MS = 7_000; // try + retry fit the 8s settle window
const MAX_JOBS_PER_DRIVE = 64;

// The slice of the ControlPlane stub the runner uses.
export interface JobBudget {
  reserve(input: {
    roomId: string;
    token: string;
    kind: string;
    day: string;
  }): Promise<{ ok: boolean }>;
  consume(input: { token: string }): Promise<unknown>;
  release(input: { token: string }): Promise<unknown>;
}

// The upstream call signature the runner uses (a string URL + init). The
// production default is `typeof fetch` (ky-backed); tests hand in plain
// async functions — either satisfies this narrower shape.
export type UpstreamFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DecisionJobDeps {
  readonly control: JobBudget | null;
  readonly apiKey: string;
  readonly fetch: UpstreamFetch;
  // The URL the upstream call posts to. JEV_ENDPOINT in production; the
  // JEV_UPSTREAM_URL binding (local/test only) retargets it at a fixture.
  readonly url: string;
  readonly nowMs: () => number;
}

// Test/dev seam — the runner resolves deps per drive; an injected object
// replaces any field (mock upstream fetch, fixed clock, stubbed budget).
let injectedDeps: Partial<DecisionJobDeps> | null = null;
export const injectDecisionJobDeps = (deps: Partial<DecisionJobDeps> | null): void => {
  injectedDeps = deps;
};

export const resolveJobDeps = (env: ServerBindings): DecisionJobDeps => {
  const ns = env.CONTROL_PLANE;
  const envControl = ns === undefined ? null : ns.get(ns.idFromName(CONTROL_PLANE_NAME));
  const envUrl = env.JEV_UPSTREAM_URL?.trim() ?? "";
  return {
    control: injectedDeps?.control !== undefined ? injectedDeps.control : envControl,
    apiKey: injectedDeps?.apiKey ?? env.JEV_API_KEY?.trim() ?? "",
    fetch: injectedDeps?.fetch ?? jevOutboundFetch,
    url: injectedDeps?.url ?? (envUrl === "" ? JEV_ENDPOINT : envUrl),
    nowMs: injectedDeps?.nowMs ?? (() => Date.now()),
  };
};

// The GameRoom surface the runner needs (beyond broadcasting).
export interface DecisionJobHost extends BroadcastHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  setBooks(books: Books): void;
}

export interface JobRunReport {
  readonly done: number;
  readonly failed: number;
  readonly pending: number;
}

export const runDecisionJobs = async (
  host: DecisionJobHost,
  deps: DecisionJobDeps,
): Promise<JobRunReport> => {
  const report = { done: 0, failed: 0, pending: 0 };
  const books = host.booksView();
  if (books === null) return report;
  // Terminal failures below persist decisionFailed rows — one broadcast at
  // the end of the pass covers every row written during it.
  const since = maxEventSeq(host.sql);
  try {
    if (deps.apiKey === "" || deps.control === null) {
      // Missing config / budget service fails closed: pending jobs die, the
      // game never freezes (posts stay pending -> settle noContest).
      for (const job of listClaimableJobs(host.sql)) {
        host.txn(() => failJobRow(host.sql, job.token, "config"));
      }
      return report;
    }
    const narrowed = { ...deps, control: deps.control };
    let processed = 0;
    for (const job of listClaimableJobs(host.sql)) {
      if (processed >= MAX_JOBS_PER_DRIVE) break;
      if (job.tries >= MAX_JOB_TRIES) {
        host.txn(() => failJobRow(host.sql, job.token, "tries"));
        continue;
      }
      processed += 1;
      const out = await runOneJob(host, narrowed, job).catch(() => "failed" as const);
      if (out === "done") report.done += 1;
      else if (out === "failed") report.failed += 1;
      else report.pending += 1;
    }
    return report;
  } finally {
    // Terminal failures persisted decisionFailed rows — re-sync the
    // in-memory revision so the next commitAction can't collide on
    // events.seq, then push every row written during the pass.
    syncBooksRevision(host);
    broadcastNewEvents(host, since, host.booksView()?.state ?? null);
  }
};

// Single-flight drain loop behind GameRoom.driveDecisionJobs: re-checks
// the claim list after each pass — a job committed while a drive was
// mid-flight must never wait for an unrelated trigger. The settle check
// below is not optional: entering "complete" with the cutoff already
// fully evaluated emits ZERO evaluate commands, so nothing else would
// ever derive the claim and every such game would die at the window.
export const drainDecisionJobs = async (
  host: DecisionJobHost,
  deps: DecisionJobDeps,
): Promise<void> => {
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const report = await runDecisionJobs(host, deps).catch(() => null);
      if (report === null) return;
      // No forward progress (all pending work is cap-blocked or the queue
      // is empty) — another pass would find the same rows.
      if (report.done + report.failed === 0) return;
      if (listClaimableJobs(host.sql).length === 0) return;
    }
  } finally {
    maybeSettle(host, deps);
  }
};

// Recovery pass run in the GameRoom constructor: rows left "reserved" or
// "sent" by a lost isolate are orphaned attempts — suppress them to
// "failed" (the post stays pending -> settle noContest) and consume their
// ControlPlane grants. Returns how many rows were suppressed.
export const recoverInterruptedJobs = async (
  host: DecisionJobHost,
  deps: DecisionJobDeps,
  gameEpoch: number,
): Promise<number> => {
  const since = maxEventSeq(host.sql);
  const rows = host.txn(() => {
    const suppressed = suppressInterruptedJobs(host.sql);
    for (const row of suppressed) {
      recordRoomEvent(host.sql, "decisionFailed", { postId: row.token, code: "suppressed" });
    }
    return suppressed;
  });
  if (rows.length > 0) {
    syncBooksRevision(host);
    broadcastNewEvents(host, since, host.booksView()?.state ?? null);
  }
  if (rows.length === 0 || deps.control === null) return rows.length;
  for (const row of rows) {
    await deps.control
      .consume({ token: suppressedAttemptToken(host.roomId, gameEpoch, row) })
      .catch(() => {});
  }
  return rows.length;
};

// Constructor wiring: suppress orphaned attempts (never resend), then
// re-drive whatever pending work survived the eviction — all inside
// ctx.waitUntil so a DO constructor never blocks on ControlPlane.
export const scheduleJobRecovery = (
  ctx: Pick<DurableObjectState, "waitUntil">,
  host: DecisionJobHost & { driveDecisionJobs(): Promise<void> },
  env: ServerBindings,
  gameEpoch: number,
): void => {
  ctx.waitUntil(
    recoverInterruptedJobs(host, resolveJobDeps(env), gameEpoch).then(async () => {
      if (listClaimableJobs(host.sql).length > 0) await host.driveDecisionJobs();
    }),
  );
};

// Test hook: force a job row into a state (e.g. simulate a "sent" row
// whose response was lost) without going through the send boundary.
export const forceJobStateForTest = (
  host: DecisionJobHost,
  token: string,
  state: string,
  tries: number,
): void => {
  host.txn(() => {
    host.sql.exec("UPDATE ai_jobs SET state = ?, tries = ? WHERE token = ?", state, tries, token);
  });
};

export const jobRowForTest = (host: DecisionJobHost, token: string) =>
  host.txn(() => findAiJob(host.sql, token));
