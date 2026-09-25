// Public message feed: every accepted post rendered as slot badge + name +
// verbatim text. Text nodes are React-interpolated, so markup in a post is
// inert by construction. Screen-reader announcements are limited to a
// visually-hidden live region carrying ONLY the newest post — the scrollback
// list itself is never a live region, so readers are not flooded.
import { type CSSProperties, useEffect, useRef } from "react";
import type { Player, PlayerId, PostedInput } from "@yuragoo/game-core";
import styles from "./MessageFeed.module.css";
import { slotBadge, slotColor } from "./slots";

export interface MessageFeedProps {
  readonly posts: readonly PostedInput[];
  readonly roster: readonly Player[];
  readonly nameOf?: ((id: PlayerId) => string) | undefined;
}

export function MessageFeed(props: MessageFeedProps) {
  const { posts, roster, nameOf = (id) => id } = props;
  const listRef = useRef<HTMLUListElement | null>(null);
  const latest = posts[posts.length - 1];

  useEffect(() => {
    const list = listRef.current;
    if (list !== null && posts.length > 0) {
      list.scrollTop = list.scrollHeight;
    }
  }, [posts]);

  const slotOf = (playerId: PlayerId): number => roster.find((p) => p.id === playerId)?.slot ?? -1;

  return (
    <section className={styles.feed} aria-label="投稿フィード">
      <ul ref={listRef} className={styles.list} data-testid="feed-list">
        {posts.map((post) => {
          const slot = slotOf(post.playerId);
          return (
            <li key={post.postId} className={styles.item} data-testid="feed-item">
              <span
                className={styles.slotChip}
                style={{ "--slot-bg": slotColor(slot) } as CSSProperties}
                aria-hidden="true"
              >
                {slotBadge(slot)}
              </span>
              <span className={styles.name} title={nameOf(post.playerId)}>
                {nameOf(post.playerId)}
              </span>
              <span className={styles.text}>{post.text}</span>
            </li>
          );
        })}
      </ul>
      <p className={styles.srOnly} aria-live="polite" data-testid="live-announcer">
        {latest === undefined ? "" : `${nameOf(latest.playerId)} が投稿：${latest.text}`}
      </p>
    </section>
  );
}
