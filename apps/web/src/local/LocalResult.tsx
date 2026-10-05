// Result overlay for /play (Task 15): a chamfered plate over the arena that
// replays the scenario, lists every choice with its slot color/symbol and
// owning player, then names the outcome — winner with their choice, ひきわけ,
// or a reason-aware noContest line. 「もう一回」rematches a fresh epoch.
// Task 27: rendered through the Dialog primitive — focus moves to the
// heading, focus is trapped, Esc/とじる dismisses to the finished arena
// and a corner chip re-opens it (focus lands back on the chip).
import { type CSSProperties, useRef, useState } from "react";
import type { GameOutcome, GameState, PlayerId } from "@yuragoo/game-core";
import { slotColor } from "../game/slots";
import { type Locale, useLocale, useT, type Translate, tx } from "../i18n";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import uiStyles from "../ui/ui.module.css";
import styles from "./LocalGame.module.css";
import { choicesFor, localNameOf, localScenario } from "./scenario";

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

const outcomeText = (
  outcome: GameOutcome | null,
  game: GameState,
  lang: Locale,
  t: Translate,
): string => {
  if (outcome === null) return "…";
  switch (outcome.kind) {
    case "winner": {
      const choice = choicesFor(game.roster.length, lang)[outcome.slot];
      const name = localNameOf(outcome.playerId, lang);
      return choice === undefined
        ? t("{name} の勝ち！", { name })
        : t("{name} の勝ち！ {symbol} {label}", {
            name,
            symbol: choice.symbol,
            label: choice.label,
          });
    }
    case "draw":
      return t("ひきわけ");
    case "noContest": {
      const reason = NO_CONTEST_TEXT[outcome.reason];
      return reason === undefined ? t("むこう") : t(reason);
    }
    default:
      return "…";
  }
};

export function LocalResult(props: LocalResultProps) {
  const { game, onRematch } = props;
  const t = useT();
  const lang = useLocale();
  const [dismissed, setDismissed] = useState(false);
  const reopenRef = useRef<HTMLButtonElement | null>(null);
  const choices = choicesFor(game.roster.length, lang);
  const ownerOf = (slot: number) => game.roster.find((p) => p.slot === slot);
  const nameOf = (id: PlayerId): string => localNameOf(id, lang);

  if (dismissed) {
    return (
      <Button
        className={uiStyles.reopen}
        ref={reopenRef}
        data-testid="result-reopen"
        onClick={() => setDismissed(false)}
      >
        {t("けっかをみる")}
      </Button>
    );
  }
  return (
    <Dialog
      label={t("けっか")}
      veil="paper"
      testId="result-overlay"
      onClose={() => setDismissed(true)}
      returnFocus={() => reopenRef.current}
    >
      <h2 className={styles.title} data-autofocus tabIndex={-1}>
        {t("けっか")}
      </h2>
      <p className={styles.scenario}>{localScenario(lang)}</p>
      <ul className={styles.choices}>
        {choices.map((choice, slot) => {
          const owner = ownerOf(slot);
          const ownerName = owner === undefined ? "—" : nameOf(owner.id);
          return (
            <li
              key={choice.id}
              className={styles.choice}
              data-testid="result-choice"
              aria-label={t("{symbol} {label} — {name}", {
                symbol: choice.symbol,
                label: choice.label,
                name: ownerName,
              })}
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
        {outcomeText(game.outcome, game, lang, t)}
      </p>
      <div className={styles.resultButtons}>
        <Button variant="big" data-testid="rematch-button" onClick={onRematch}>
          {t("もう一回")}
        </Button>
        <Button onClick={() => setDismissed(true)}>{t("とじる")}</Button>
      </div>
    </Dialog>
  );
}

// Non-hook variant for tests/non-React callers.
export const localOutcomeText = (
  outcome: GameOutcome | null,
  game: GameState,
  lang: Locale,
): string => outcomeText(outcome, game, lang, (ja, vars) => tx(lang, ja, vars));
