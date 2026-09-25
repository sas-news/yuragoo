// Result overlay for /play (Task 15): a chamfered plate over the arena that
// replays the scenario, lists every choice with its slot color/symbol and
// owning player, then names the outcome — winner with their choice, ひきわけ,
// or a reason-aware noContest line. 「もう一回」rematches a fresh epoch.
// Task 27: rendered through the Dialog primitive — focus moves to the
// heading, focus is trapped, Esc/とじる dismisses to the finished arena
// and a corner chip re-opens it (focus lands back on the chip).
import { type CSSProperties, useRef, useState } from "react";
import type { GameOutcome, GameState } from "@yuragoo/game-core";
import { slotColor } from "../game/slots";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import uiStyles from "../ui/ui.module.css";
import styles from "./LocalGame.module.css";
import { choicesFor, LOCAL_SCENARIO, localNameOf } from "./scenario";

export interface LocalResultProps {
  readonly game: GameState;
  readonly onRematch: () => void;
}

const NO_CONTEST_TEXT: Readonly<Record<string, string>> = {
  pending: "こたえがまにあわなかった",
  timeout: "じかんぎれ",
  budget: "AIがつかれちゃった",
  aborted: "ちゅうだん",
};

const outcomeText = (outcome: GameOutcome | null, game: GameState): string => {
  if (outcome === null) return "…";
  switch (outcome.kind) {
    case "winner": {
      const choice = choicesFor(game.roster.length)[outcome.slot];
      const name = localNameOf(outcome.playerId);
      return choice === undefined
        ? `${name} の勝ち！`
        : `${name} の勝ち！ ${choice.symbol} ${choice.label}`;
    }
    case "draw":
      return "ひきわけ";
    case "noContest":
      return NO_CONTEST_TEXT[outcome.reason] ?? "むこう";
    default:
      return "…";
  }
};

export function LocalResult(props: LocalResultProps) {
  const { game, onRematch } = props;
  const [dismissed, setDismissed] = useState(false);
  const reopenRef = useRef<HTMLButtonElement | null>(null);
  const choices = choicesFor(game.roster.length);
  const ownerOf = (slot: number) => game.roster.find((p) => p.slot === slot);

  if (dismissed) {
    return (
      <Button
        className={uiStyles.reopen}
        ref={reopenRef}
        data-testid="result-reopen"
        onClick={() => setDismissed(false)}
      >
        けっかをみる
      </Button>
    );
  }
  return (
    <Dialog
      label="けっか"
      veil="paper"
      testId="result-overlay"
      onClose={() => setDismissed(true)}
      returnFocus={() => reopenRef.current}
    >
      <h2 className={styles.title} data-autofocus tabIndex={-1}>
        けっか
      </h2>
      <p className={styles.scenario}>{LOCAL_SCENARIO}</p>
      <ul className={styles.choices}>
        {choices.map((choice, slot) => {
          const owner = ownerOf(slot);
          const ownerName = owner === undefined ? "—" : localNameOf(owner.id);
          return (
            <li
              key={choice.id}
              className={styles.choice}
              data-testid="result-choice"
              aria-label={`${choice.symbol} ${choice.label} — ${ownerName}`}
            >
              <span
                className={styles.choiceBadge}
                style={{ "--slot-bg": slotColor(slot) } as CSSProperties}
                aria-hidden="true"
              >
                {choice.symbol}
              </span>
              <span className={styles.choiceLabel}>{choice.label}</span>
              <span className={styles.owner}>{ownerName}</span>
            </li>
          );
        })}
      </ul>
      <p className={styles.outcome} data-testid="result-outcome">
        {outcomeText(game.outcome, game)}
      </p>
      <div className={styles.resultButtons}>
        <Button variant="big" data-testid="rematch-button" onClick={onRematch}>
          もう一回
        </Button>
        <Button onClick={() => setDismissed(true)}>とじる</Button>
      </div>
    </Dialog>
  );
}
