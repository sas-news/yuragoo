// Normal-generation budget gate (Task 22): one "pre" slot (pre-game) and
// one "post" slot (post-game) per game — the actual LLM call is Task 31;
// this module only owns the durable, per-game spend bookkeeping.
//
// The spend is per-GAME (not room-lifetime): a rematch bumps
// meta.gameEpoch and clears the table (commands.ts commitRematch), so a
// new game earns fresh slots. The meta.generationAttempts counter is the
// human-visible total for the game; the generation_slots table is the
// authoritative per-slot ledger (a row = the slot was spent).
import type { Books } from "./due";
import { writeMeta } from "./storage";
import type { DecisionJobHost } from "./decision-jobs";

export type GenerationSlot = "pre" | "post";
export const GENERATION_SLOTS: readonly GenerationSlot[] = ["pre", "post"];

const parseSlot = (slot: string): GenerationSlot | null =>
  slot === "pre" || slot === "post" ? slot : null;

export const slotSpent = (sql: SqlStorage, slot: GenerationSlot): boolean =>
  sql.exec("SELECT slot FROM generation_slots WHERE slot = ?", slot).toArray().length > 0;

// How many slot rows exist — used to seed meta.generationAttempts when a
// game is created after a lobby-phase ("pre") spend.
export const spentSlotCount = (sql: SqlStorage): number =>
  sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM generation_slots").one().n;

export const clearGenerationSlots = (sql: SqlStorage): void => {
  sql.exec("DELETE FROM generation_slots");
};

// Reserve a slot — returns true exactly once per slot per game. The write
// is atomic inside the caller's transaction: the slot row and the
// generation_attempts counter land together or not at all.
// Task 25: the "pre" slot is spendable in the lobby BEFORE a game exists
// (books === null); the counter bump then waits for commitCreate, which
// seeds generationAttempts from the slot rows. A finished game never
// spends — rematch clears the table for the next game's fresh slots.
export const spendGenerationSlot = (host: DecisionJobHost, slot: string): boolean => {
  const parsed = parseSlot(slot);
  if (parsed === null) return false;
  return host.txn(() => {
    const books: Books | null = host.booksView();
    if (books !== null && books.state.phase === "finished") return false;
    if (slotSpent(host.sql, parsed)) return false;
    host.sql.exec(
      "INSERT INTO generation_slots (slot, spent_at_ms) VALUES (?, ?)",
      parsed,
      Date.now(),
    );
    if (books !== null) {
      writeMeta(host.sql, {
        ...books.meta,
        generationAttempts: books.meta.generationAttempts + 1,
      });
      host.setBooks({
        meta: { ...books.meta, generationAttempts: books.meta.generationAttempts + 1 },
        state: books.state,
      });
    }
    return true;
  });
};
