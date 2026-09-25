// Deterministic story-highlight extraction (Task 29): walks the persisted
// event ledger and picks the 3-5 events worth a kamishibai page — the
// start, the biggest lead reversal, the biggest distribution impact, the
// last decision before the end and the result. Every pick cites its
// events.seq so a panel always traces back to a fact, and every tie
// resolves to the earlier seq so the same ledger yields the same story.
//
// The panel set is deliberately the ONLY structured view of a match that
// downstream generation may see — the raw event log never leaves here.
import type { GameOutcome } from "../outcome";
import type { PanelDraft } from "./panels";

export interface StoryEventRow {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

// The minimal ledger shape buildStory needs. Roster slot order equals the
// committed choice order, so choices[i] is slot i's attractor.
export interface StorySource {
  readonly events: readonly StoryEventRow[];
  readonly posts: readonly { postId: string; playerId: string; text: string; seq: number }[];
  readonly roster: readonly { id: string; slot: number }[];
  readonly choices: readonly { choiceId: string; label: string }[];
  readonly scenario: string;
  readonly outcome: GameOutcome;
  // Display name of the winning player, resolved by the caller (player
  // ids are wire keys, never readable copy). null outside a winner.
  readonly winnerName: string | null;
}

// One landed decisionUpdated row. revision is the seq of the post the
// evaluation covered — coverage windows are measured in post seqs, while
// ordering and citation use event seqs.
export interface LandedDecision {
  readonly seq: number;
  readonly postId: string;
  readonly revision: number;
  readonly dist: ReadonlyMap<string, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Ledger rows are untrusted JSON: one malformed field discards the whole
// row — a partially-read distribution would silently skew the scores.
const parseLanded = (row: StoryEventRow): LandedDecision | null => {
  const payload = row.payload;
  if (!isRecord(payload)) return null;
  const { postId, revision, distribution } = payload;
  if (typeof postId !== "string" || postId.length === 0) return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  if (!Array.isArray(distribution)) return null;
  const dist = new Map<string, number>();
  for (const entry of distribution as readonly unknown[]) {
    if (!isRecord(entry)) return null;
    const { choiceId, probability } = entry;
    if (typeof choiceId !== "string" || choiceId.length === 0) return null;
    if (typeof probability !== "number" || !Number.isFinite(probability)) return null;
    if (probability < 0 || probability > 1) return null;
    dist.set(choiceId, probability);
  }
  return { seq: row.seq, postId, revision, dist };
};

// pull = per-roster-slot attraction: slot i takes the probability the
// distribution gave to choices[i].choiceId, renormalized over matched
// slots. null when nothing matched — the panel then renders at rest.
const pullOf = (
  choices: readonly { choiceId: string }[],
  dist: ReadonlyMap<string, number>,
): readonly number[] | null => {
  const raw = choices.map((c) => dist.get(c.choiceId) ?? 0);
  const sum = raw.reduce((acc, v) => acc + v, 0);
  if (sum <= 0) return null;
  return raw.map((v) => v / sum);
};

// Leader = argmax slot of a pull. prev (the running leader) wins ties;
// the first leader's ties fall to the lowest index. -1 means no pull.
const leaderOf = (pull: readonly number[] | null, prev: number): number => {
  if (pull === null) return -1;
  let best = -1;
  for (let i = 0; i < pull.length; i += 1) {
    const value = pull[i] ?? 0;
    const bestValue = best === -1 ? Number.NEGATIVE_INFINITY : (pull[best] ?? 0);
    if (value > bestValue || (value === bestValue && i === prev)) best = i;
  }
  return best;
};

// "Before" of the first landed event: uniform across committed choices.
const uniformPull = (count: number): readonly number[] | null =>
  count > 0 ? Array.from({ length: count }, () => 1 / count) : null;

const uniformDist = (choices: readonly { choiceId: string }[]): ReadonlyMap<string, number> => {
  const map = new Map<string, number>();
  if (choices.length === 0) return map;
  for (const c of choices) map.set(c.choiceId, 1 / choices.length);
  return map;
};

// distributionImpact = 0.5 * sum|dp| over the union of choice ids — kept
// local so game-core never depends on packages/ai for one formula.
const distributionImpact = (
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): number => {
  let sum = 0;
  for (const [choiceId, p] of after) sum += Math.abs(p - (before.get(choiceId) ?? 0));
  for (const [choiceId, p] of before) {
    if (!after.has(choiceId)) sum += p;
  }
  return sum / 2;
};

// Index of the best score (null = not a candidate). Only a strictly
// greater score replaces, so ties keep the earlier event.
const bestIndex = (scores: readonly (number | null)[]): number => {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < scores.length; i += 1) {
    const score = scores[i];
    if (score === null || score === undefined) continue;
    if (best === -1 || score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
};

const lastRowOf = (rows: readonly StoryEventRow[], type: string): StoryEventRow | null => {
  let found: StoryEventRow | null = null;
  for (const row of rows) {
    if (row.type === type) found = row;
  }
  return found;
};

const draft = (
  kind: PanelDraft["kind"],
  seq: number,
  pull: readonly number[] | null,
  landedIndex: number,
  leaderLabel: string | null,
): PanelDraft => ({ kind, seq, pull, landedIndex, leaderLabel });

// The five candidates in story order (start, reversal, impact, endgame,
// result) — here we only decide WHICH events deserve a page; coverage,
// schema shaping and text live in panels.ts/templates.ts.
export const pickDrafts = (
  source: StorySource,
): { drafts: readonly (PanelDraft | null)[]; landed: LandedDecision[] } => {
  const rows = [...source.events].sort((a, b) => a.seq - b.seq);
  const landed = rows
    .filter((row) => row.type === "decisionUpdated")
    .map(parseLanded)
    .filter((l): l is LandedDecision => l !== null);

  const startedRow = rows.find((row) => row.type === "started") ?? null;
  const completeRow = lastRowOf(rows, "complete");
  const finishedRow = lastRowOf(rows, "finished");

  const choices = source.choices;
  const pulls = landed.map((l) => pullOf(choices, l.dist));
  const uniform = uniformPull(choices.length);

  // Reversal + impact scoring in one pass. before_i's leader is the
  // running leader after event i-1 — when pull_{i-1} is null there is no
  // leader to overturn, so a reversal requires both leaders to exist.
  const reversalScores: (number | null)[] = [];
  const impacts: number[] = [];
  const leaders: number[] = [];
  let running = leaderOf(uniform, -1);
  for (let i = 0; i < landed.length; i += 1) {
    const beforePull = i === 0 ? uniform : (pulls[i - 1] ?? null);
    const beforeLeader = beforePull === null ? -1 : running;
    const afterLeader = leaderOf(pulls[i] ?? null, beforeLeader);
    const gain = (pulls[i]?.[afterLeader] ?? 0) - (beforePull?.[afterLeader] ?? 0);
    reversalScores.push(
      beforeLeader >= 0 && afterLeader >= 0 && afterLeader !== beforeLeader ? gain : null,
    );
    running = afterLeader >= 0 ? afterLeader : running;
    leaders.push(afterLeader);
    const beforeDist = i === 0 ? uniformDist(choices) : (landed[i - 1]?.dist ?? new Map());
    impacts.push(distributionImpact(beforeDist, landed[i]?.dist ?? new Map()));
  }

  const reversalIndex = bestIndex(reversalScores);

  // Impact ranks every landed event (highest delta, earliest seq first);
  // the reversal's event is skipped so the two panels never collide.
  const reversalSeq = reversalIndex >= 0 ? (landed[reversalIndex]?.seq ?? -1) : -1;
  const impactIndex =
    landed
      .map((_, i) => i)
      .sort((a, b) => (impacts[b] ?? 0) - (impacts[a] ?? 0) || a - b)
      .find((i) => (landed[i]?.seq ?? -1) !== reversalSeq) ?? -1;

  // Endgame: the last decision before the complete row, else the complete
  // row itself (no pull), else the last decision when no complete exists.
  let endgameIndex = -1;
  for (let i = 0; i < landed.length; i += 1) {
    if (completeRow === null || (landed[i]?.seq ?? 0) < completeRow.seq) endgameIndex = i;
  }

  const endgameDraft =
    endgameIndex >= 0
      ? draft(
          "endgame",
          landed[endgameIndex]?.seq ?? 0,
          pulls[endgameIndex] ?? null,
          endgameIndex,
          null,
        )
      : completeRow === null
        ? null
        : draft("endgame", completeRow.seq, null, -1, null);

  const drafts: (PanelDraft | null)[] = [
    startedRow === null ? null : draft("start", startedRow.seq, null, -1, null),
    reversalIndex < 0
      ? null
      : draft(
          "reversal",
          landed[reversalIndex]?.seq ?? 0,
          pulls[reversalIndex] ?? null,
          reversalIndex,
          choices[leaders[reversalIndex] ?? -1]?.label ?? null,
        ),
    impactIndex < 0
      ? null
      : draft(
          "impact",
          landed[impactIndex]?.seq ?? 0,
          pulls[impactIndex] ?? null,
          impactIndex,
          null,
        ),
    endgameDraft,
    finishedRow === null
      ? null
      : draft("result", finishedRow.seq, pulls[pulls.length - 1] ?? null, -1, null),
  ];
  return { drafts, landed };
};
