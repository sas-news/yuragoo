// The deadlines table is the single source of truth for the room's one
// alarm. set-deadline commands carry a tag (turn | match | settle) and the
// row id is that tag, so one tag can never arm two clocks: re-arming a tag
// replaces its row. The alarm scheduled on storage is always min(run_at),
// recomputed after every mutation by the caller (GameRoom.rearm).
type DeadlineSqlRow = { id: string; run_at: number; tag: string };

export interface Deadline {
  readonly id: string;
  readonly runAt: number;
  readonly tag: string;
}

const toDeadline = (row: DeadlineSqlRow): Deadline => ({
  id: row.id,
  runAt: row.run_at,
  tag: row.tag,
});

export const listDeadlines = (sql: SqlStorage): Deadline[] =>
  sql
    .exec<DeadlineSqlRow>("SELECT id, run_at, tag FROM deadlines ORDER BY run_at")
    .toArray()
    .map(toDeadline);

// Rows whose fire time has arrived. Consumed to an array before the caller
// does anything else — a cursor must never cross an await boundary.
export const dueDeadlines = (sql: SqlStorage, nowMs: number): Deadline[] =>
  sql
    .exec<DeadlineSqlRow>(
      "SELECT id, run_at, tag FROM deadlines WHERE run_at <= ? ORDER BY run_at",
      nowMs,
    )
    .toArray()
    .map(toDeadline);

export const replaceDeadline = (sql: SqlStorage, id: string, runAt: number, tag: string): void => {
  sql.exec("INSERT OR REPLACE INTO deadlines (id, run_at, tag) VALUES (?, ?, ?)", id, runAt, tag);
};

export const deleteDeadlineIds = (sql: SqlStorage, ids: readonly string[]): void => {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(", ");
  sql.exec(`DELETE FROM deadlines WHERE id IN (${marks})`, ...ids);
};

export const minDeadlineRunAt = (sql: SqlStorage): number | null =>
  sql.exec<{ m: number | null }>("SELECT MIN(run_at) AS m FROM deadlines").one().m;
