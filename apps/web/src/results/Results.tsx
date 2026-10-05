// The shared results dialog (Task 32): replaces the old one-line outcome
// popup with the kamishibai recap. Every member gets the identical panel
// set (server-authoritative); while the room is still building it the
// dialog shows a soft pending line instead of dead space. Rematch-readiness
// is the existing backToLobby flow (any member reopens the lobby for all);
// room close stays host-gated with an explicit confirm.
import { useRef, useState } from "react";
import { SLOT_SYMBOLS } from "../game/slots";
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

const outcomeLine = (view: RoomView): string => {
  const outcome = view.outcome;
  if (outcome === null) return "";
  switch (outcome.kind) {
    case "winner": {
      const name = memberName(view.players, outcome.playerId);
      const label = view.lobby.choices[outcome.slot]?.label;
      const symbol = SLOT_SYMBOLS[outcome.slot] ?? "?";
      return label === undefined
        ? `${symbol} ${name} の勝ち！`
        : `${symbol} ${name} の勝ち！ — ${label}`;
    }
    case "draw":
      return "ひきわけ";
    case "noContest":
      return `むこう（${NO_CONTEST_TEXT[outcome.reason] ?? outcome.reason}）`;
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
        けっかをみる
      </Button>
    );
  }

  const run = (fn: () => Promise<unknown> | undefined) => {
    setBusy(true);
    void fn()
      ?.then(() => setBusy(false))
      .catch((e: Error) => {
        setBusy(false);
        setError(commandErrorText(e));
      });
  };

  return (
    <Dialog
      label="けっか"
      veil="paper"
      testId="room-results"
      onClose={() => setDismissed(true)}
      returnFocus={() => reopenRef.current}
      panelClassName={styles.resultsPanel}
    >
      <h2 className={styles.title} data-autofocus tabIndex={-1}>
        けっか
      </h2>
      <p className={styles.outcomeLine} data-testid="results-outcome">
        {outcomeLine(view)}
      </p>
      {view.ending === null ? (
        <p className={styles.pending} data-testid="story-pending">
          おわりの紙芝居を用意しています…
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
          <p className={styles.confirmText}>へやを閉じると、みんなの記録も消えます。いいですか？</p>
          <Button
            variant="primary"
            data-testid="close-room-confirm"
            disabled={busy}
            onClick={() => run(closeRoom)}
          >
            へやを閉じる
          </Button>
          <Button data-testid="close-room-cancel" onClick={() => setConfirming(false)}>
            やめる
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
            ロビーにもどる
          </Button>
          {isHost && (
            <Button data-testid="close-room" onClick={() => setConfirming(true)}>
              へやを閉じる
            </Button>
          )}
          <Button data-testid="results-close" onClick={() => setDismissed(true)}>
            とじる
          </Button>
        </div>
      )}
      <LegalFoot />
    </Dialog>
  );
}
