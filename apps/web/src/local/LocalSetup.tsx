// Pre-match setup card for /play: player count (2–6), TURN/LIVE toggle and
// the start button — a chamfered ivory plate on the flat paper world, same
// outline idiom as the seat chips and the input dock. URL params seed the
// initial values; this panel only edits them before the first match.
import { Button } from "../ui/Button";
import styles from "./LocalGame.module.css";
import { LOCAL_PERSONA, LOCAL_SCENARIO } from "./scenario";
import type { LocalSetup } from "./session";

export interface LocalSetupProps {
  readonly setup: LocalSetup;
  readonly onChange: (setup: LocalSetup) => void;
  readonly onStart: () => void;
}

const COUNTS = [2, 3, 4, 5, 6] as const;

export function LocalSetupPanel(props: LocalSetupProps) {
  const { setup, onChange, onStart } = props;
  return (
    <div className={styles.setupWrap}>
      <section className={styles.card} data-testid="setup-panel" aria-label="ゲームの設定">
        <h1 className={styles.title}>ゆらぐー！</h1>
        <p className={styles.scenario}>{LOCAL_SCENARIO}</p>
        <p className={styles.persona}>生きもの：{LOCAL_PERSONA}</p>
        <fieldset className={styles.group}>
          <legend className={styles.label}>にんずう</legend>
          {COUNTS.map((count) => (
            <button
              key={count}
              type="button"
              className={styles.chipButton}
              data-testid={`count-${count}`}
              aria-pressed={setup.players === count}
              onClick={() => onChange({ ...setup, players: count })}
            >
              {count}人
            </button>
          ))}
        </fieldset>
        <fieldset className={styles.group}>
          <legend className={styles.label}>モード</legend>
          <button
            type="button"
            className={styles.chipButton}
            data-testid="mode-turn"
            aria-pressed={setup.mode === "turn"}
            onClick={() => onChange({ ...setup, mode: "turn" })}
          >
            じゅんばん
          </button>
          <button
            type="button"
            className={styles.chipButton}
            data-testid="mode-live"
            aria-pressed={setup.mode === "live"}
            onClick={() => onChange({ ...setup, mode: "live" })}
          >
            いっせいに
          </button>
        </fieldset>
        <Button variant="big" data-testid="start-button" onClick={onStart}>
          はじめる
        </Button>
      </section>
    </div>
  );
}
