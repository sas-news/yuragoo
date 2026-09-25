// Post-reaction flicker: when a fresh post lands in state.posts the creature
// visibly "hears" it — stage visualState flashes "hesitating" while the
// presentation biases attraction toward the poster's slot and switches to
// the hesitating expression, then settles back to the base presentation.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CreaturePresentation, StageVisualState } from "@yuragoo/creature";
import type { Player, PlayerId, PostedInput } from "@yuragoo/game-core";

export interface PostReaction {
  readonly stageState: StageVisualState;
  readonly presentation: CreaturePresentation;
}

// ~950ms minimum so the "聞いた" flicker is always readable; while the post
// still awaits its verdict the lean HOLDS (up to ~6s — the Jev window plus
// one retry) so the creature never idles back to center between "heard it"
// and かたよりました. The landed distribution then takes over the base pull
// in the same frame the hold releases.
const HOLD_MIN_MS = 950;
const HOLD_MAX_MS = 6000;
// During the flicker the poster's attractor takes this share of the pull.
const REACTION_WEIGHT = 0.55;

interface Reactor {
  readonly postId: string;
  readonly playerId: PlayerId;
  readonly at: number;
}

export const usePostReaction = (
  posts: readonly PostedInput[],
  roster: readonly Player[],
  base: CreaturePresentation,
): PostReaction => {
  const [reactor, setReactor] = useState<Reactor | null>(null);
  // Seeded with the posts already present on first render so replayed state
  // never re-triggers the reaction for history.
  const seenRef = useRef<Set<string>>(new Set(posts.map((p) => p.postId)));
  // The release timer lives in a ref, not the effect's cleanup: the effect
  // re-runs when posts flip pending -> evaluated, and a cleanup would kill
  // the in-flight timer before it can clear the hold.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fresh = posts.filter((post) => !seenRef.current.has(post.postId));
    for (const post of fresh) seenRef.current.add(post.postId);
    const last = fresh[fresh.length - 1];
    if (last !== undefined) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setReactor({ postId: last.postId, playerId: last.playerId, at: Date.now() });
      return;
    }
    if (reactor === null) return;
    const post = posts.find((p) => p.postId === reactor.postId);
    const settled = post === undefined || post.status !== "pending";
    const remaining = reactor.at + (settled ? HOLD_MIN_MS : HOLD_MAX_MS) - Date.now();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (remaining <= 0) setReactor(null);
    else timerRef.current = setTimeout(() => setReactor(null), remaining);
  }, [posts, reactor]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const presentation = useMemo<CreaturePresentation>(() => {
    if (reactor === null) return base;
    const slot = roster.find((p) => p.id === reactor.playerId)?.slot;
    const count = base.samples.length;
    const rest = count > 1 ? (1 - REACTION_WEIGHT) / (count - 1) : 0;
    return {
      ...base,
      expression: "hesitating",
      samples: base.samples.map((sample, i) => ({
        ...sample,
        weight: i === slot ? REACTION_WEIGHT : rest,
      })),
    };
  }, [reactor, roster, base]);

  return {
    stageState: reactor === null ? "normal" : "hesitating",
    presentation,
  };
};
