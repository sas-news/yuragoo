// The shared results dialog (Task 32): replaces the old one-line outcome
// popup with the kamishibai recap. Every member gets the identical panel
// set (server-authoritative); while the room is still building it the
// dialog shows a soft pending line instead of dead space. Rematch-readiness
// is the existing backToLobby flow (any member reopens the lobby for all);
// room close stays host-gated with an explicit confirm.
import { useRef, useState } from "react";
import { SLOT_SYMBOLS } from "../game/slots";
import { type Locale, useLocale, useT, type Translate, tx } from "../i18n";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { LegalFoot } from "../ui/LegalLinks";
import uiStyles from "../ui/ui.module.css";
import { commandErrorText } from "../lobby/lobby-errors";
import type { RoomView } from "../lobby/room-view";
import { memberName } from "../lobby/view-members";
import { Kamishibai } from "./Kamishibai";
import styles from "./Results.module.css";

const NO_CONTEST_TEXT: Readonly<Record<string, string>> = {
  pending: "こたえがまにあわなかった",
  timeout: "じかんぎれ",
  budget: "AIがつかれちゃった",
  aborted: "ちゅうだん",
};

// The headline mixes shared content (member name, choice label — always
// the room language) with viewer chrome ("wins!", "draw") in the UI locale.
const outcomeLine = (view: RoomView, t: Translate): string => {
  const outcome = view.outcome;
  if (outcome === null) return "";
  switch (outcome.kind) {
    case "winner": {
      const name = memberName(view.players, outcome.playerId, t);
      const label = view.lobby.choices[outcome.slot]?.label;
      const symbol = SLOT_SYMBOLS[outcome.slot] ?? "?";
      return label === undefined
        ? t("{symbol} {name} の勝ち！", { symbol, name })
        : t("{symbol} {name} の勝ち！ — {label}", { symbol, name, label });
    }
    case "draw":
      return t("ひきわけ");
    case "noContest": {
      const reason = NO_CONTEST_TEXT[outcome.reason];
      return t("むこう（{reason}）", {
        reason: reason === undefined ? outcome.reason : t(reason),
      });
    }
    default:
      return "";
  }
};

export interface ResultsProps {
  readonly view: RoomView;
  readonly isHost: boolean;
  readonly backToLobby: () => Promise<unknown> | undefined;
  readonly closeRoom: () => Promise<unknown> | undefined;
}

export function Results({ view, isHost, backToLobby, closeRoom }: ResultsProps) {
  const t = useT();
  const lang = useLocale();
  const [dismissed, setDismissed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reopenRef = useRef<HTMLButtonElement | null>(null);

  if (view.outcome === null) return null;
  if (dismissed) {
    return (
      <Button
        className={uiStyles.reopen}
        ref={reopenRef}
        data-testid="outcome-reopen"
        onClick={() => setDismissed(false)}
      >
        {t("けっかをみる")}
      </Button>
    );
  }

  const run = (fn: () => Promise<unknown> | undefined) => {
    setBusy(true);
    void fn()
      ?.then(() => setBusy(false))
      .catch((e: Error) => {
        setBusy(false);
        setError(commandErrorText(e, lang));
      });
  };

  return (
    <Dialog
      label={t("けっか")}
      veil="paper"
      testId="room-results"
      onClose={() => setDismissed(true)}
      returnFocus={() => reopenRef.current}
      panelClassName={styles.resultsPanel}
    >
      <h2 className={styles.title} data-autofocus tabIndex={-1}>
        {t("けっか")}
      </h2>
      <p className={styles.outcomeLine} data-testid="results-outcome">
        {outcomeLine(view, t)}
      </p>
      {view.ending === null ? (
        <p className={styles.pending} data-testid="story-pending">
          {t("おわりの紙芝居を用意しています…")}
        </p>
      ) : (
        <Kamishibai story={view.ending} />
      )}
      {error !== null && (
        <p className={styles.errorNote} role="alert">
          {error}
        </p>
      )}
      {confirming ? (
        <div className={styles.dialogButtons} data-testid="close-confirm">
          <p className={styles.confirmText}>
            {t("へやを閉じると、みんなの記録も消えます。いいですか？")}
          </p>
          <Button
            variant="primary"
            data-testid="close-room-confirm"
            disabled={busy}
            onClick={() => run(closeRoom)}
          >
            {t("へやを閉じる")}
          </Button>
          <Button data-testid="close-room-cancel" onClick={() => setConfirming(false)}>
            {t("やめる")}
          </Button>
        </div>
      ) : (
        <div className={styles.dialogButtons}>
          <Button
            variant="primary"
            data-testid="back-to-lobby"
            disabled={busy}
            onClick={() => run(backToLobby)}
          >
            {t("ロビーにもどる")}
          </Button>
          {isHost && (
            <Button data-testid="close-room" onClick={() => setConfirming(true)}>
              {t("へやを閉じる")}
            </Button>
          )}
          <Button data-testid="results-close" onClick={() => setDismissed(true)}>
            {t("とじる")}
          </Button>
        </div>
      )}
      <LegalFoot />
    </Dialog>
  );
}

// Re-exported so non-React call sites (tests, story builders) can render
// the same outcome line without a hook.
export const outcomeLineFor = (view: RoomView, lang: Locale): string =>
  outcomeLine(view, (ja, vars) => tx(lang, ja, vars));
