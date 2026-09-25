// Speech-bubble overlay for the party table. Each fresh post pops a big,
// readable bubble on the INWARD side of the poster's seat chip — between
// the chip and the creature, never covering the seat, and it never
// travels. The tail spike points OUT at the chip. Seats slide
// tangentially when needed so the bubble stays inside the arena (~10px
// margin) and clears every chip. The silhouette is a measured SVG path
// (chamfered rect + tail spike) stroked once in bodyDeep teal — a uniform
// ~2.4px outline on every edge, no drop-shadow hacks — with a solid
// slot-colored tail and a small hard offset shadow.
// Lifecycle: pop-in ~380ms (scale .5 -> 1.05 -> 1), hold ~4.5s, pop-out
// ~320ms, then unmount. A `seen` set keeps replayed state from respawning;
// a new post from the same player replaces their bubble; at most
// MAX_BUBBLES alive. Reduced motion: same anchor, fade only.
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Player, PlayerId, PostedInput } from "@yuragoo/game-core";
import {
  BUBBLE_CUT,
  type Pt,
  type Rect,
  bubbleAnchor,
  chamferedBubblePath,
  spikePath,
  tailFor,
} from "./bubblePath";
import styles from "./BubbleLayer.module.css";
import { CHIP_SIZE, type SeatMap } from "./seats";
import { slotColor } from "./slots";

export interface BubbleLayerProps {
  readonly posts: readonly PostedInput[];
  readonly roster: readonly Player[];
  readonly seats: SeatMap;
}

interface Bubble {
  readonly postId: string;
  readonly playerId: PlayerId;
  readonly slot: number;
  readonly text: string;
  readonly seatX: number; // chip center, layer px — the tail aims back here
  readonly seatY: number;
  readonly blockers: readonly Rect[]; // other chips to clear, layer px
  readonly layerW: number;
  readonly layerH: number;
}

interface Placement {
  readonly cx: number; // bubble center, layer px
  readonly cy: number;
  readonly w: number; // measured box
  readonly h: number;
  readonly frame: string; // union path: chamfered rect + tail spike
  readonly spike: string; // slot-colored tail triangle ("" when no tail)
  readonly deg: number; // tail direction, screen deg (0 = +x, 90 = +y)
}

const MAX_BUBBLES = 6;
const MAX_GRAPHEMES = 80;
// Fallback seat when no anchor exists yet: just below center.
const FALLBACK = { x: 50, y: 78 } as const;

const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

// Grapheme-aware truncation: never splits a cluster (か+゙, emoji, …).
const truncate = (text: string): string => {
  const parts =
    segmenter === null ? Array.from(text) : Array.from(segmenter.segment(text), (s) => s.segment);
  return parts.length > MAX_GRAPHEMES ? `${parts.slice(0, MAX_GRAPHEMES - 1).join("")}…` : text;
};

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

interface BubbleViewProps {
  readonly bubble: Bubble;
  readonly reduced: boolean;
  readonly onDone: (postId: string) => void;
}

function BubbleView(props: BubbleViewProps) {
  const { bubble, reduced, onDone } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const placeRef = useRef<Placement | null>(null);

  // Measure the box (layout effect + ResizeObserver for font/reflow
  // changes): push the center inward past the chip rim, clamp inside the
  // arena, slide tangentially if a chip is still covered, then aim the
  // tail spike back at the chip — all in measured px via bubblePath.ts.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 2 || h < 2) return;
      const seat: Pt = { x: bubble.seatX, y: bubble.seatY };
      const center = bubbleAnchor(
        seat,
        { x: bubble.layerW / 2, y: bubble.layerH / 2 },
        { w, h },
        CHIP_SIZE,
        { w: bubble.layerW, h: bubble.layerH },
        bubble.blockers,
      );
      const seatLocal = { x: seat.x - (center.x - w / 2), y: seat.y - (center.y - h / 2) };
      const chipLocal = {
        x: seatLocal.x - CHIP_SIZE.w / 2,
        y: seatLocal.y - CHIP_SIZE.h / 2,
        w: CHIP_SIZE.w,
        h: CHIP_SIZE.h,
      };
      const tail = tailFor(seatLocal, { w, h }, chipLocal);
      const next: Placement = {
        cx: center.x,
        cy: center.y,
        w,
        h,
        frame: chamferedBubblePath(w, h, BUBBLE_CUT, tail),
        spike: tail === null ? "" : spikePath(tail, { w, h }),
        deg: tail?.deg ?? 0,
      };
      const prev = placeRef.current;
      if (
        prev !== null &&
        Math.abs(prev.cx - next.cx) < 0.5 &&
        Math.abs(prev.cy - next.cy) < 0.5 &&
        prev.w === next.w &&
        prev.h === next.h
      ) {
        return;
      }
      placeRef.current = next;
      setPlace(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bubble]);

  const style = {
    left: `${place === null ? bubble.seatX : place.cx}px`,
    top: `${place === null ? bubble.seatY : place.cy}px`,
    visibility: place === null ? "hidden" : "visible",
    "--bubble-color": slotColor(bubble.slot),
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className={styles.bubble}
      style={style}
      data-testid={`bubble-${bubble.postId}`}
      data-slot={bubble.slot}
      data-tail-angle={place === null ? undefined : Math.round(place.deg)}
      data-motion={reduced ? "reduced" : "pop"}
      onAnimationEnd={() => onDone(bubble.postId)}
    >
      {place === null ? null : (
        <svg
          className={styles.frame}
          viewBox={`0 0 ${place.w} ${place.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          data-testid="bubble-frame"
        >
          <path className={styles.shadow} d={place.frame} transform="translate(4 5)" />
          <path className={styles.body} d={place.frame} />
          {place.spike === "" ? null : (
            <path className={styles.tailFill} data-testid="bubble-tail" d={place.spike} />
          )}
          <path className={styles.outline} data-testid="bubble-outline" d={place.frame} />
        </svg>
      )}
      <span className={styles.text}>{bubble.text}</span>
    </div>
  );
}

export function BubbleLayer(props: BubbleLayerProps) {
  const { posts, roster, seats } = props;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const [bubbles, setBubbles] = useState<readonly Bubble[]>([]);
  const [reduced, setReduced] = useState(() => window.matchMedia(reducedMotionQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const onChange = () => setReduced(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const fresh = posts.filter((post) => !seenRef.current.has(post.postId));
    if (fresh.length === 0) return;
    for (const post of fresh) seenRef.current.add(post.postId);
    const layer = layerRef.current;
    if (layer === null) return;
    const rect = layer.getBoundingClientRect();
    const spawned: Bubble[] = fresh.map((post) => {
      const seat = seats[post.playerId] ?? {
        x: (FALLBACK.x / 100) * rect.width,
        y: (FALLBACK.y / 100) * rect.height,
      };
      const blockers = Object.entries(seats)
        .filter(([id]) => id !== post.playerId)
        .map(([, s]) => ({
          x: s.x - CHIP_SIZE.w / 2,
          y: s.y - CHIP_SIZE.h / 2,
          w: CHIP_SIZE.w,
          h: CHIP_SIZE.h,
        }));
      return {
        postId: post.postId,
        playerId: post.playerId,
        slot: roster.find((p) => p.id === post.playerId)?.slot ?? -1,
        text: truncate(post.text),
        seatX: seat.x,
        seatY: seat.y,
        blockers,
        layerW: rect.width,
        layerH: rect.height,
      };
    });
    // A new post from the same player replaces their bubble outright.
    const replaced = new Set(spawned.map((b) => b.playerId));
    setBubbles((prev) =>
      [...prev.filter((b) => !replaced.has(b.playerId)), ...spawned].slice(-MAX_BUBBLES),
    );
  }, [posts, roster, seats]);

  const removeBubble = (postId: string): void => {
    setBubbles((prev) => prev.filter((b) => b.postId !== postId));
  };

  return (
    <div ref={layerRef} className={styles.layer} aria-hidden="true">
      {bubbles.map((bubble) => (
        <BubbleView key={bubble.postId} bubble={bubble} reduced={reduced} onDone={removeBubble} />
      ))}
    </div>
  );
}
