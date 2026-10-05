// The kamishibai reader (Task 32): identical panel set for every member,
// but each person turns pages at their own pace — no host-synced paging,
// so a slow reader never holds the room and a fast one can sit on the
// result. Paging is local state; the set itself is server-authoritative.
import { useMemo, useState } from "react";
import type { EndingStory } from "@yuragoo/protocol";
import { useT } from "../i18n";
import { Button } from "../ui/Button";
import { Panel } from "./Panel";
import styles from "./Results.module.css";

export interface KamishibaiProps {
  readonly story: EndingStory;
}

export function Kamishibai({ story }: KamishibaiProps) {
  const t = useT();
  const [index, setIndex] = useState(0);
  // The wire order already follows the ledger, but events drafted out of
  // turn (a reversal picked on a later seq than the impact pick) must
  // still read chronologically — the strip replays seq ascending.
  const panels = useMemo(
    () => [...story.panels].sort((a, b) => a.eventId - b.eventId),
    [story.panels],
  );
  const panel = panels[index];
  if (panel === undefined) return null;
  const last = index === panels.length - 1;
  return (
    <section className={styles.kamishibai} aria-label={t("おわりの紙芝居")}>
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
          {t("まえ")}
        </Button>
        <span className={styles.pageCount} data-testid="page-count" aria-live="polite">
          {index + 1} / {panels.length}
        </span>
        <Button
          variant="plain"
          data-testid="panel-next"
          disabled={last}
          onClick={() => setIndex((i) => Math.min(panels.length - 1, i + 1))}
        >
          {t("つぎ")}
        </Button>
      </div>
    </section>
  );
}
