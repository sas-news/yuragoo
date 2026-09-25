// Due-deadline dispatch for the room's single alarm. Each due row is fired
// through the same atomic commit path as apply() (minus dedupe) inside the
// caller's transactionSync: fired rows are deleted in the same commit, so
// a duplicate alarm delivery finds no due rows, and a stale row whose
// action no longer applies is still consumed. GameRuleError rejections
// from stale actions are swallowed; storage errors abort the commit.
import { GameRuleError, type GameAction, type GameState } from "@yuragoo/game-core";
import { type Deadline, deleteDeadlineIds } from "./deadlines";
import { commitAction, type MetaRow } from "./storage";

export interface Books {
  readonly meta: MetaRow;
  readonly state: GameState;
}

export const fireDueDeadlines = (
  sql: SqlStorage,
  books: Books,
  due: readonly Deadline[],
): Books => {
  deleteDeadlineIds(
    sql,
    due.map((d) => d.id),
  );
  let cur = books;
  for (const d of due) {
    const nowMs = Math.max(Date.now(), d.runAt);
    const action: GameAction =
      d.tag === "settle" ? { type: "settle-deadline", nowMs } : { type: "deadline-reached", nowMs };
    try {
      const committed = commitAction(sql, cur.meta, cur.state, action);
      cur = { meta: committed.meta, state: committed.state };
    } catch (e) {
      console.log("[due] fire failed", d.tag, e instanceof Error ? e.message : String(e));
      if (!(e instanceof GameRuleError)) throw e;
    }
  }
  return cur;
};
