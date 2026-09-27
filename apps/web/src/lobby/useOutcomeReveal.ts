// Results reveal delay (Task 40): the outcome never pops the dialog the
// frame it lands — a short veil ("さあ、けっかは…") holds for ~2.4s so the
// finish lands as a moment, not a modal. The gate is keyed on the outcome
// object: backToLobby nulls it, so a rematch never re-shows the old one,
// and the veil only ever arms for a FRESH result.
import { useEffect, useState } from "react";
import type { GameOutcome } from "@yuragoo/game-core";

export const REVEAL_MS = 2400;

// ?reveal=0 shortens the suspense — e2e and impatient devs can skip it.
const revealMs = (): number => {
  const raw = new URLSearchParams(window.location.search).get("reveal");
  const ms = raw === null ? REVEAL_MS : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : REVEAL_MS;
};

export interface OutcomeReveal {
  // The outcome is known and the suspense window has closed — Results may open.
  readonly revealed: boolean;
  // During the window: render the veil instead of the dialog.
  readonly showingVeil: boolean;
}

export const useOutcomeReveal = (outcome: GameOutcome | null): OutcomeReveal => {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (outcome === null) {
      setRevealed(false);
      return;
    }
    if (revealed) return;
    const t = setTimeout(() => setRevealed(true), revealMs());
    return () => clearTimeout(t);
  }, [outcome, revealed]);

  return { revealed, showingVeil: outcome !== null && !revealed };
};
