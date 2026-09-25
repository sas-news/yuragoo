// Local-match content (Task 15): one fixed scenario/persona, a pool of six
// choices — the lab's food theme extended to six so a full table fills every
// attractor — and the helpers that map an AI distribution onto the creature's
// canonical slot angles. Player ids and display names are fixed too: the
// single-screen match has no accounts, seats just get passed around.
import { type AttractionSample, CANONICAL_SLOT_ANGLES } from "@yuragoo/creature";
import { type ChoiceId, type DecisionDistribution, parseChoiceId } from "@yuragoo/protocol";
import { SLOT_SYMBOLS } from "../game/slots";

export const LOCAL_SCENARIO = "おやつの時間。目の前に食べ物がならんでいる。";
export const LOCAL_PERSONA = "甘党の生きもの";

export interface LocalChoice {
  readonly id: ChoiceId;
  readonly symbol: string;
  readonly label: string;
}

const CHOICE_IDS = ["a", "b", "c", "d", "e", "f"] as const;
const CHOICE_LABELS = [
  "季節限定の濃厚プリン",
  "素朴な塩むすび",
  "なぞの紫色のゼリー",
  "何も食べずに我慢する",
  "あつあつのたいやき",
  "ひんやりクリームソーダ",
] as const;

// Choice i pairs with slot i: the symbol is the same SLOT_SYMBOLS badge the
// seat chips carry, so the result list and the arena read as one system.
export const LOCAL_CHOICES: readonly LocalChoice[] = CHOICE_IDS.map((id, i) => ({
  id: parseChoiceId(id),
  symbol: SLOT_SYMBOLS[i] ?? "?",
  label: CHOICE_LABELS[i] ?? "?",
}));

// Fixed six-seat roster (pre-shuffle ids; seed decides who sits where).
export const LOCAL_PLAYER_IDS = ["aiko", "ren", "yuu", "riku", "sora", "nagi"] as const;
export const LOCAL_NAMES: Readonly<Record<string, string>> = {
  aiko: "あいこ",
  ren: "れん",
  yuu: "ゆう",
  riku: "りく",
  sora: "そら",
  nagi: "なぎ",
};
export const localNameOf = (id: string): string => LOCAL_NAMES[id] ?? id;

// The first N choices — one per seat, in slot order.
export const choicesFor = (rosterSize: number): readonly LocalChoice[] =>
  LOCAL_CHOICES.slice(0, Math.max(0, Math.min(rosterSize, LOCAL_CHOICES.length)));

// Attraction samples for the creature: each choice sits on its canonical
// slot angle with the evaluated weight; a missing distribution is uniform.
export const samplesFor = (
  distribution: readonly DecisionDistribution[] | null,
  rosterSize: number,
): readonly AttractionSample[] => {
  const angles = CANONICAL_SLOT_ANGLES[rosterSize] ?? [];
  const choices = choicesFor(rosterSize);
  const fallback = choices.length > 0 ? 1 / choices.length : 0;
  return choices.map((choice, i) => ({
    angleRad: angles[i] ?? 0,
    weight: distribution?.find((d) => d.choiceId === choice.id)?.probability ?? fallback,
  }));
};

// Argmax over the distribution, lowest index wins a tie. Distribution order
// is the choices order (providers answer in requested order), so the index
// IS the roster slot.
export const dominantSlot = (distribution: readonly DecisionDistribution[]): number => {
  let best = 0;
  for (let i = 1; i < distribution.length; i += 1) {
    const current = distribution[i];
    const top = distribution[best];
    if (current !== undefined && top !== undefined && current.probability > top.probability) {
      best = i;
    }
  }
  return best;
};

// Clear-dominance verdict for the early-decision streak (15b): the argmax
// slot only when it leads the runner-up by at least DOMINANCE_MARGIN — the
// same top-2 threshold the lab uses for 葛藤 (CONFLICT_MARGIN). A knife-edge
// or uniform distribution is "no verdict": the streak resets, never counts.
export const DOMINANCE_MARGIN = 0.15;

export const dominanceOf = (distribution: readonly DecisionDistribution[]): number | null => {
  if (distribution.length === 0) return null;
  const best = dominantSlot(distribution);
  const top = distribution[best]?.probability ?? 0;
  let second = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < distribution.length; i += 1) {
    if (i === best) continue;
    const p = distribution[i]?.probability ?? 0;
    if (p > second) second = p;
  }
  return top - second >= DOMINANCE_MARGIN ? best : null;
};
