// Pre-match setup card for /play: player count (2–6), TURN/LIVE toggle and
// the start button — a chamfered ivory plate on the flat paper world, same
// outline idiom as the seat chips and the input dock. URL params seed the
// initial values; this panel only edits them before the first match.
import { useLocale, useT } from "../i18n";
import { Button } from "../ui/Button";
import styles from "./LocalGame.module.css";
import { localPersona, localScenario } from "./scenario";
import type { LocalSetup } from "./session";

export interface LocalSetupProps {
  readonly setup: LocalSetup;
  readonly onChange: (setup: LocalSetup) => void;
  readonly onStart: () => void;
}

const COUNTS = [2, 3, 4, 5, 6] as const;

export function LocalSetupPanel(props: LocalSetupProps) {
  const { setup, onChange, onStart } = props;
  const t = useT();
  const lang = useLocale();
  return (
    <div className={styles.setupWrap}>
      <section className={styles.card} data-testid="setup-panel" aria-label={t("ゲームの設定")}>
        <h1 className={styles.title}>ゆらぐー！</h1>
        <p className={styles.scenario}>{localScenario(lang)}</p>
        <p className={styles.persona}>
          {t("生きもの：{persona}", { persona: localPersona(lang) })}
        </p>
        <fieldset className={styles.group}>
          <legend className={styles.label}>{t("にんずう")}</legend>
          {COUNTS.map((count) => (
            <button
              key={count}
              type="button"
              className={styles.chipButton}
              data-testid={`count-${count}`}
              aria-pressed={setup.players === count}
              onClick={() => onChange({ ...setup, players: count })}
            >
              {t("{n}人", { n: count })}
            </button>
          ))}
        </fieldset>
        <fieldset className={styles.group}>
          <legend className={styles.label}>{t("モード")}</legend>
          <button
            type="button"
            className={styles.chipButton}
            data-testid="mode-turn"
            aria-pressed={setup.mode === "turn"}
            onClick={() => onChange({ ...setup, mode: "turn" })}
          >
            {t("じゅんばん")}
          </button>
          <button
            type="button"
            className={styles.chipButton}
            data-testid="mode-live"
            aria-pressed={setup.mode === "live"}
            onClick={() => onChange({ ...setup, mode: "live" })}
          >
            {t("いっせいに")}
          </button>
        </fieldset>
        <Button variant="big" data-testid="start-button" onClick={onStart}>
          {t("はじめる")}
        </Button>
      </section>
    </div>
  );
}
