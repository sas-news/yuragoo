// LIVE-mode rule helper: any roster player may post while the match is
// playing, bounded only by maxPendingPerPlayer posts still awaiting
// evaluation. There are no turns — accepting never rotates order.
import type { GameCommand, GameTransition } from "./commands";
import { GameRuleError, type GameState, type PlayerId, type PostedInput } from "./state";

export const acceptLivePost = (
  state: GameState,
  playerId: PlayerId,
  text: string,
  nowMs: number,
): GameTransition => {
  const pending = state.posts.filter(
    (p) => p.playerId === playerId && p.status === "pending",
  ).length;
  if (pending >= state.settings.maxPendingPerPlayer) {
    throw new GameRuleError(
      "pending-slot",
      `player ${playerId} already has ${pending} pending post(s)`,
    );
  }
  const seq = state.seq + 1;
  const post: PostedInput = {
    postId: `p${seq}`,
    playerId,
    text,
    postedAtMs: nowMs,
    seq,
    status: "pending",
  };
  const commands: GameCommand[] = [
    { type: "evaluate", postId: post.postId, seq },
    { type: "publish", event: { type: "posted", postId: post.postId, playerId } },
  ];
  // An accepted post is pending evaluation and may reverse the leader —
  // it always releases the dwell; the client re-reports adhere after.
  return {
    state: { ...state, posts: [...state.posts, post], seq, adhesion: null },
    commands,
  };
};
