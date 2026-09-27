// Post-verdict direction cue (Task 40): when a Jev distribution lands,
// a slot-colored arrow streaks from the creature toward the pulled seat
// for ~1.7s. "どっちに動いたか" reads on the ARENA itself — the feed line
// alone was too subtle. The cue keys on the newest evaluated post's
// postId so replayed history never re-fires it.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { PlayerId } from "@yuragoo/game-core";
import { pulledSlot } from "../lobby/room-arena";
import type { RoomView } from "../lobby/room-view";
import styles from "./PullCue.module.css";
import type { SeatMap } from "./seats";
import { slotColor } from "./slots";

const CUE_MS = 1700;

export interface PullCueProps {
  readonly view: RoomView;
  readonly seats: SeatMap;
  // Reports the currently-pulsed player id so the seat chip can play its
  // own outward lurch alongside the arrow.
  readonly onPulled?: ((id: PlayerId | undefined) => void) | undefined;
}

export function PullCue({ view, seats, onPulled }: PullCueProps) {
  // The wrap is the arena box — measure once via a callback ref (state,
  // not a ref read at render) so the arrow always knows the geometry.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    if (el !== null) {
      const r = el.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    }
  }, []);
  const [pulse, setPulse] = useState<{ postId: string; slot: number } | null>(null);

  const target = useMemo(() => {
    for (let i = view.posts.length - 1; i >= 0; i -= 1) {
      const post = view.posts[i];
      if (post === undefined || post.status !== "evaluated") continue;
      const slot = pulledSlot(view.dists.get(post.postId) ?? null, view);
      return slot === null ? null : { postId: post.postId, slot };
    }
    return null;
  }, [view]);

  useEffect(() => {
    if (target === null || pulse?.postId === target.postId) return;
    setPulse(target);
    const t = setTimeout(() => setPulse(null), CUE_MS);
    return () => clearTimeout(t);
  }, [target, pulse]);

  useEffect(() => {
    const id = pulse === null ? undefined : view.roster.find((p) => p.slot === pulse.slot)?.id;
    onPulled?.(id);
  }, [pulse, view.roster, onPulled]);

  const player = pulse === null ? undefined : view.roster.find((p) => p.slot === pulse.slot);
  const seat = player === undefined ? undefined : seats[player.id];
  const show = pulse !== null && seat !== undefined && box !== null && box.w > 0;
  if (!show || seat === undefined || box === null || pulse === null) {
    return <div ref={wrapRef} className={styles.wrap} aria-hidden="true" />;
  }
  const cx = box.w / 2;
  const cy = box.h / 2;
  const dx = seat.x - cx;
  const dy = seat.y - cy;
  const style = {
    left: `${cx}px`,
    top: `${cy}px`,
    width: `${Math.hypot(dx, dy)}px`,
    transform: `rotate(${Math.atan2(dy, dx)}rad)`,
    "--cue-color": slotColor(pulse.slot),
  } as CSSProperties;
  return (
    <div ref={wrapRef} className={styles.wrap} aria-hidden="true">
      <div className={styles.arrow} data-testid="pull-cue" style={style}>
        <span className={styles.shaft} />
        <span className={styles.head} />
      </div>
    </div>
  );
}
