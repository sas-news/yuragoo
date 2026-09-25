// The early-decision dwell (Task 15b) — a consecutive-dominance streak over
// evaluated posts, replacing the old seconds-based timer: `grace` straight
// evals with the same clear winner fire dwell-complete. The streak math is
// pure (session.dwellStep); this file is only the impure glue — re-reporting
// adhere, firing, and arming ONE retry at the adhesionSeconds boundary when
// the reducer's hold check hasn't elapsed yet. A new post clears the
// reducer's adhesion but NOT the streak — the grace posts ARE the streak —
// so adhere is re-reported on every dominant step (skipping it was the bug
// where the ring/dwell never came back after the first post).
import type { GameAction, GameState } from "@yuragoo/game-core";
import type { DecisionDistribution } from "@yuragoo/protocol";
import { dwellStep, type DwellState, latestEvaluatedDist } from "./session";

export interface DwellDeps {
  readonly grace: number;
  readonly getState: () => GameState | null;
  readonly dists: ReadonlyMap<string, readonly DecisionDistribution[]>;
  readonly dispatch: (action: GameAction) => void;
  // setTimeout wrapper that registers the timer for epoch cleanup.
  readonly schedule: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface Dwell {
  // A post's evaluation landed: step the streak, re-adhere, maybe fire.
  readonly step: () => void;
  // A post was accepted: the armed retry is stale (the reducer just cleared
  // the adhesion it would fire against) — drop it; the streak survives.
  readonly interrupted: () => void;
  readonly reset: () => void;
}

export const createDwell = (deps: DwellDeps): Dwell => {
  let streak: DwellState = { slot: null, streak: 0 };
  let retry: ReturnType<typeof setTimeout> | null = null;

  const cancelRetry = (): void => {
    if (retry !== null) {
      deps.cancel(retry);
      retry = null;
    }
  };

  const fire = (): void => {
    try {
      deps.dispatch({ type: "dwell-complete", nowMs: Date.now() });
      cancelRetry();
      return;
    } catch {
      // Rejected. Only "the hold hasn't lasted adhesionSeconds" earns ONE
      // retry armed for the remaining window; any other reason (a pending
      // post, lost adhesion, a moved-on phase) just keeps playing — the
      // next dominant eval re-fires from scratch.
      const s = deps.getState();
      if (s?.phase !== "playing" || s.adhesion === null || retry !== null) return;
      const leftMs = s.settings.adhesionSeconds * 1000 - (Date.now() - s.adhesion.sinceMs);
      if (leftMs <= 0) return;
      retry = deps.schedule(() => {
        retry = null;
        try {
          deps.dispatch({ type: "dwell-complete", nowMs: Date.now() });
        } catch {
          // A post landed in between — the next eval re-arms if dominant.
        }
      }, leftMs);
    }
  };

  return {
    step: () => {
      const s = deps.getState();
      if (s === null || s.phase !== "playing") {
        streak = { slot: null, streak: 0 };
        cancelRetry();
        return;
      }
      const next = dwellStep(streak, latestEvaluatedDist(s.posts, deps.dists), deps.grace);
      streak = { slot: next.slot, streak: next.streak };
      if (next.adhere !== null) {
        try {
          deps.dispatch({ type: "adhere", slot: next.adhere, nowMs: Date.now() });
        } catch {
          // Bookkeeping only — a rejected report never stops the match.
        }
      }
      if (next.fire) fire();
    },
    interrupted: cancelRetry,
    reset: () => {
      streak = { slot: null, streak: 0 };
      cancelRetry();
    },
  };
};
