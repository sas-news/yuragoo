// Decision verdict folds for the room view (Task 43): a decisionUpdated
// row carries both the pull distribution AND Jev's mood pick for that
// post — the face and the lean always belong to the same verdict — while
// decisionFailed only flips the post out of pending. Type-only imports
// keep this module a leaf, like view-members.ts.
import type { PostedInput } from "@yuragoo/game-core";
import type { DecisionDistribution, MoodId, ServerEnvelope } from "@yuragoo/protocol";
import type { RoomView } from "./room-view";

export type DecisionEvent = Extract<ServerEnvelope, { type: "decisionUpdated" | "decisionFailed" }>;

// A landed decision (or terminal failure) flips the post out of pending —
// the feed never revisits a settled post.
const markEvaluated = (posts: readonly PostedInput[], postId: string): readonly PostedInput[] =>
  posts.map((p) => (p.postId === postId ? { ...p, status: "evaluated" as const } : p));

export const decisionPatch = (
  view: RoomView,
  env: DecisionEvent,
): Partial<Pick<RoomView, "dists" | "moods" | "posts">> => {
  if (env.type === "decisionFailed") {
    // The eval is never coming; no dist lands, so latestRoomDist still
    // skips it — the bubble already shows the text either way.
    return { posts: markEvaluated(view.posts, env.payload.postId) };
  }
  const { postId, distribution, mood } = env.payload;
  if (postId === undefined || distribution === undefined) return {};
  return {
    dists: new Map(view.dists).set(postId, distribution),
    // Mood is optional on the wire: a mood-less verdict keeps the map as
    // is (the face falls back to the shape heuristic for that post).
    moods: mood === undefined ? view.moods : new Map(view.moods).set(postId, mood),
    posts: markEvaluated(view.posts, postId),
  };
};

// The postId whose distribution the creature is currently wearing — the
// newest evaluated post that actually landed a verdict. Mood lookups key
// off this same post so face and pull can never mix verdicts.
export const latestVerdictPostId = (
  posts: readonly PostedInput[],
  dists: ReadonlyMap<string, readonly DecisionDistribution[]>,
): string | null => {
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const post = posts[i];
    if (post === undefined || post.status !== "evaluated") continue;
    if (dists.has(post.postId)) return post.postId;
  }
  return null;
};

export const moodOf = (moods: ReadonlyMap<string, MoodId>, postId: string | null): MoodId | null =>
  postId === null ? null : (moods.get(postId) ?? null);
