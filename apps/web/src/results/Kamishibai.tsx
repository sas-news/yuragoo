// The kamishibai reader (Task 32): identical panel set for every member,
// but each person turns pages at their own pace — no host-synced paging,
// so a slow reader never holds the room and a fast one can sit on the
// result. Paging is local state; the set itself is server-authoritative.
import { useState } from "react";
import type { EndingStory } from "@yuragoo/protocol";
import { Button } from "../ui/Button";
import { Panel } from "./Panel";
import styles from "./Results.module.css";

export interface KamishibaiProps {
  readonly story: EndingStory;
}

export function Kamishibai({ story }: KamishibaiProps) {
  const [index, setIndex] = useState(0);
  const panel = story.panels[index];
  if (panel === undefined) return null;
  const last = index === story.panels.length - 1;
  return (
    <section className={styles.kamishibai} aria-label="おわりの紙芝居">
      <p className={styles.storyTitle} data-testid="story-title">
        {story.title}
      </p>
      <Panel panel={panel} />
      <div className={styles.pager}>
        <Button
          variant="plain"
          data-testid="panel-prev"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          まえ
        </Button>
        <span className={styles.pageCount} data-testid="page-count" aria-live="polite">
          {index + 1} / {story.panels.length}
        </span>
        <Button
          variant="plain"
          data-testid="panel-next"
          disabled={last}
          onClick={() => setIndex((i) => Math.min(story.panels.length - 1, i + 1))}
        >
          つぎ
        </Button>
      </div>
    </section>
  );
}
