// ai_jobs / ai_results row layer for the Task-22 decision-job runner. All
// functions are synchronous SQLite steps the caller composes inside
// transactionSync — nothing here opens its own transaction.
//
// Job state machine (ai_jobs.state):
//   pending  -> claimable (tries < MAX_JOB_TRIES); never durably sent
//   reserved -> a ControlPlane grant is held for attempt `tries + 1`
//   sent     -> the upstream call was durably started (tries bumped)
//   done     -> a result was committed to the game ledger
//   failed   -> terminal (denied, errored or suppressed)
// `tries` only ever increments inside the same transactionSync that marks
// "sent", so a "reserved"/"sent" row found at recovery means an orphaned
// attempt — it is suppressed to "failed" (consumed, never re-sent), which
// is the at-most-once fail-safe: the upstream call may have reached Jev.
import { type MoodId, moodIdSchema } from "@yuragoo/protocol";

export const MAX_JOB_TRIES = 2; // 1 attempt + at most 1 retry (contract)

export interface AiJobRow {
  readonly token: string; // the postId this job evaluates
  readonly cutoffSeq: number;
  readonly state: string;
  readonly tries: number;
}

type JobSqlRow = { token: string; cutoff_seq: number; state: string; tries: number };

const toJob = (r: JobSqlRow): AiJobRow => ({
  token: r.token,
  cutoffSeq: r.cutoff_seq,
  state: r.state,
  tries: r.tries,
});

const JOB_COLUMNS = "token, cutoff_seq, state, tries";

export const findAiJob = (sql: SqlStorage, token: string): AiJobRow | null => {
  const row = sql
    .exec<JobSqlRow>(`SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE token = ?`, token)
    .toArray()[0];
  return row === undefined ? null : toJob(row);
};

// Claimable rows in cutoff order: pending work with a try left. The caller
// still re-checks state inside the marking transaction — this list can go
// stale the moment it's read (it only feeds a best-effort pass).
export const listClaimableJobs = (sql: SqlStorage): AiJobRow[] =>
  sql
    .exec<JobSqlRow>(
      `SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE state = 'pending' ORDER BY cutoff_seq`,
    )
    .toArray()
    .map(toJob);

export const setAiJobState = (sql: SqlStorage, token: string, state: string): void => {
  sql.exec("UPDATE ai_jobs SET state = ? WHERE token = ?", state, token);
};

// The durable send boundary: state -> "sent" and tries + 1 atomically.
export const markAiJobSent = (sql: SqlStorage, token: string): void => {
  sql.exec("UPDATE ai_jobs SET state = 'sent', tries = tries + 1 WHERE token = ?", token);
};

// The reservation token for one durable attempt. postIds are deterministic
// per room (`p<seq>`), so the room id AND the game epoch go into the token
// — two rooms or a rematch's fresh postIds can never replay another
// game's spent grants in the shared daily ledger.
export const attemptToken = (
  roomId: string,
  gameEpoch: number,
  postId: string,
  attemptNo: number,
): string => `${roomId}:e${gameEpoch}:${postId}:${attemptNo}`;

// Recovery suppression: rows left "reserved"/"sent" by a lost isolate are
// orphaned attempts — the upstream call may have happened, so they are
// marked "failed" (the post stays pending -> settle noContest). Returns
// the suppressed rows so the caller can consume their ControlPlane grants:
// "sent" already counted its try; a still-"reserved" row had reserved for
// tries+1 but the send never became durable.
export const suppressInterruptedJobs = (sql: SqlStorage): AiJobRow[] => {
  const rows = sql
    .exec<JobSqlRow>(`SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE state IN ('reserved', 'sent')`)
    .toArray()
    .map(toJob);
  if (rows.length === 0) return [];
  sql.exec("UPDATE ai_jobs SET state = 'failed' WHERE state IN ('reserved', 'sent')");
  return rows;
};

export const suppressedAttemptToken = (roomId: string, gameEpoch: number, row: AiJobRow): string =>
  attemptToken(roomId, gameEpoch, row.token, row.state === "sent" ? row.tries : row.tries + 1);

export const insertAiResult = (sql: SqlStorage, postId: string, payload: string): void => {
  sql.exec("INSERT OR REPLACE INTO ai_results (post_id, payload) VALUES (?, ?)", postId, payload);
};

export const listAiResults = (sql: SqlStorage): { postId: string; payload: string }[] =>
  sql
    .exec<{ post_id: string; payload: string }>("SELECT post_id, payload FROM ai_results")
    .toArray()
    .map((r) => ({ postId: r.post_id, payload: r.payload }));

// Landed distributions for the snapshot's `decisions` field: payloads are
// {revision, distribution}; a corrupt row degrades to "no decision" rather
// than breaking the frame (the creature simply rests until the next eval).
export const landedDecisions = (
  sql: SqlStorage,
): Record<string, readonly { choiceId: string; probability: number }[]> =>
  Object.fromEntries(
    listAiResults(sql).flatMap((row) => {
      try {
        const d = (JSON.parse(row.payload) as { distribution?: unknown }).distribution;
        return Array.isArray(d)
          ? [[row.postId, d as readonly { choiceId: string; probability: number }[]]]
          : [];
      } catch {
        return [];
      }
    }),
  );

// Landed mood verdicts for the snapshot's `moods` field — the same
// ai_results payloads carry result.mood; a corrupt or pre-mood row
// degrades to "no mood" and the client falls back to shape-derived faces.
export const landedMoods = (sql: SqlStorage): Record<string, MoodId> =>
  Object.fromEntries(
    listAiResults(sql).flatMap((row) => {
      try {
        const parsed = moodIdSchema.safeParse((JSON.parse(row.payload) as { mood?: unknown }).mood);
        return parsed.success ? [[row.postId, parsed.data]] : [];
      } catch {
        return [];
      }
    }),
  );

// Persist one evaluate job (called from commitAction for the reducer's
// evaluate commands). DO UPDATE — not REPLACE — keeps the `tries` column:
// a replaced row would silently reset the durable send counter.
export const upsertAiJob = (
  sql: SqlStorage,
  token: string,
  cutoffSeq: number,
  state: string,
): void => {
  sql.exec(
    "INSERT INTO ai_jobs (token, cutoff_seq, state) VALUES (?, ?, ?) " +
      "ON CONFLICT(token) DO UPDATE SET cutoff_seq = excluded.cutoff_seq, state = excluded.state",
    token,
    cutoffSeq,
    state,
  );
};

// Rematch cleanup: per-game AI bookkeeping dies with the old epoch (jobs,
// landed results, spent generation slots, the early-watch streak) in the
// caller's same commit.
export const clearGameArtifacts = (sql: SqlStorage): void => {
  sql.exec("DELETE FROM ai_jobs");
  sql.exec("DELETE FROM ai_results");
  sql.exec("DELETE FROM generation_slots");
  sql.exec("DELETE FROM early_watch");
  // The kamishibai ending is per-game too — panels/quotes from the last
  // match must never bleed into a rematch or a reopened lobby.
  sql.exec("DELETE FROM ending");
};
