// Game outcomes and host settlement claims. The outcome is the single
// immutable result of a match: decided exactly once, at settle time. A
// winner is only produced from a SettleClaim whose slot maps back to the
// roster, and any post still pending inside the cutoff forces a noContest
// regardless of what the host claims — no stale AI winners, ever.
import { GameRuleError, type GameState, type PlayerId } from "./state";

export type NoContestReason = "timeout" | "aborted" | "budget" | "pending";

export type GameOutcome =
  | { readonly kind: "winner"; readonly playerId: PlayerId; readonly slot: number }
  | { readonly kind: "draw" }
  | { readonly kind: "noContest"; readonly reason: NoContestReason };

// What the host may claim at settle time. "pending" is deliberately absent
// from the claimable reasons: it is forced by resolveOutcome, never claimed.
export type SettleClaim =
  | { readonly kind: "winner"; readonly slot: number }
  | { readonly kind: "draw" }
  | { readonly kind: "noContest"; readonly reason: "timeout" | "aborted" | "budget" };

const CLAIMABLE_NO_CONTEST: ReadonlySet<string> = new Set(["timeout", "aborted", "budget"]);

// resolveOutcome maps a host claim to the final outcome for a "complete"
// state. Pending posts at seq <= settleCutoffSeq (posts the rules accepted
// before gameplay closed) always force noContest/pending — the host cannot
// win on top of an unfinished evaluation. When the cutoff was never pinned
// (a hand-built state) every post counts as inside the window.
export const resolveOutcome = (state: GameState, claim: SettleClaim): GameOutcome => {
  const cutoff = state.settleCutoffSeq ?? state.seq;
  const pendingInside = state.posts.some((p) => p.status === "pending" && p.seq <= cutoff);
  if (pendingInside) {
    return { kind: "noContest", reason: "pending" };
  }
  switch (claim.kind) {
    case "winner": {
      if (!Number.isSafeInteger(claim.slot)) {
        throw new GameRuleError("bad-state", "winner claim slot must be a safe integer");
      }
      const player = state.roster[claim.slot];
      if (player === undefined || player.slot !== claim.slot) {
        throw new GameRuleError("bad-state", `winner claim slot ${claim.slot} not in roster`);
      }
      return { kind: "winner", playerId: player.id, slot: claim.slot };
    }
    case "draw":
      return { kind: "draw" };
    case "noContest":
      if (!CLAIMABLE_NO_CONTEST.has(claim.reason)) {
        throw new GameRuleError("bad-state", `noContest reason "${claim.reason}" is not claimable`);
      }
      return { kind: "noContest", reason: claim.reason };
    default:
      throw new GameRuleError("bad-state", "malformed settle claim");
  }
};
