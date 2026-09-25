// The canvas alternative (Task 27, DESIGN.md §8.1/§9): a short NON-NUMERIC
// DOM description of what the creature is doing — direction words and
// state words only, never percentages or weights. The stage's role=status
// region reads this, and it changes only on meaningful state transitions
// (settle direction, thinking, tie, calm), never per frame.
import type { CreaturePresentation, StageVisualState } from "@yuragoo/creature";
import { slotBadge } from "./slots";

// A slot clearly owns the pull when it beats the runner-up by this margin.
const STRONG_MARGIN = 0.25;
// Top two within this band AND above the uniform share = torn between two.
const TIE_BAND = 0.06;
const TIE_MIN_FACTOR = 1.2;
// Otherwise a mild lead still deserves a direction note (DESIGN.md weak).
const LEAN_MIN_FACTOR = 1.25;

export const describeCreature = (
  visualState: StageVisualState,
  presentation: CreaturePresentation | undefined,
): string => {
  switch (visualState) {
    case "loading":
      return "よみこみちゅう…";
    case "error":
      return "うまくいかなかったみたい";
    case "hesitating":
      return "きいたことばを かんがえている";
    case "engaged":
      return "ちからを こめている";
    case "bored":
      return "たいくつしている";
    case "focus":
      return "じっと みつめている";
    case "normal":
      break; // derive from attraction below
  }
  const samples = presentation?.samples ?? [];
  if (samples.length < 2) return "おちついている";
  const total = samples.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  if (total <= 0) return "おちついている";
  const share = (i: number): number => Math.max(0, samples[i]?.weight ?? 0) / total;
  let best = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (share(i) > share(best)) best = i;
  }
  let secondShare = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (i !== best) secondShare = Math.max(secondShare, share(i));
  }
  const topShare = share(best);
  const uniform = 1 / samples.length;
  const margin = topShare - secondShare;
  if (margin >= STRONG_MARGIN) return `${slotBadge(best)} のほうへ ぐーんとのびている`;
  if (margin <= TIE_BAND && topShare >= uniform * TIE_MIN_FACTOR) {
    return "ふたつのあいだで ゆれている";
  }
  if (topShare >= uniform * LEAN_MIN_FACTOR) {
    return `${slotBadge(best)} のほうへ すこしかたむいている`;
  }
  return "おちついている";
};
