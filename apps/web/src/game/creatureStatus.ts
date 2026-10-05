// The canvas alternative (Task 27, DESIGN.md §8.1/§9): a short NON-NUMERIC
// DOM description of what the creature is doing — direction words and
// state words only, never percentages or weights. The stage's role=status
// region reads this, and it changes only on meaningful state transitions
// (settle direction, thinking, tie, calm), never per frame.
import type { CreaturePresentation, StageVisualState } from "@yuragoo/creature";
import { type Locale, tx } from "../i18n";
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
  lang: Locale = "ja",
): string => {
  const t = (ja: string, vars?: Record<string, string | number>): string => tx(lang, ja, vars);
  switch (visualState) {
    case "loading":
      return t("よみこみちゅう…");
    case "error":
      return t("うまくいかなかったみたい");
    case "hesitating":
      return t("きいたことばを かんがえている");
    case "engaged":
      return t("ちからを こめている");
    case "bored":
      return t("たいくつしている");
    case "focus":
      return t("じっと みつめている");
    case "normal":
      break; // derive from attraction below
  }
  const samples = presentation?.samples ?? [];
  if (samples.length < 2) return t("おちついている");
  const total = samples.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  if (total <= 0) return t("おちついている");
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
  if (margin >= STRONG_MARGIN) {
    return t("{slot} のほうへ ぐーんとのびている", { slot: slotBadge(best) });
  }
  if (margin <= TIE_BAND && topShare >= uniform * TIE_MIN_FACTOR) {
    return t("ふたつのあいだで ゆれている");
  }
  if (topShare >= uniform * LEAN_MIN_FACTOR) {
    return t("{slot} のほうへ すこしかたむいている", { slot: slotBadge(best) });
  }
  return t("おちついている");
};
