// The shared scenario field (Task 24). Host edits with debounced save;
// everyone else reads. `conflict` = a lobbyChanged landed on a different
// revision while this field held unsent/divergent text — non-blocking,
// the local draft wins until the server echoes it back.
// The お題をえらぶ button opens a preset picker dialog (Task 46) — the
// whole list, tapped row writes the field directly.
import { useState } from "react";
import { Dialog } from "../ui/Dialog";
import styles from "./Lobby.module.css";
import { SCENARIO_PRESETS } from "./scenario-presets";

interface ScenarioEditorProps {
  readonly editable: boolean;
  readonly value: string;
  readonly conflict: boolean;
  readonly onEdit: (value: string) => void;
}

export function ScenarioEditor({ editable, value, conflict, onEdit }: ScenarioEditorProps) {
  const [picking, setPicking] = useState(false);
  return (
    <section className={styles.plate} aria-label="シナリオ">
      <div className={styles.plateHeader}>
        <h2 className={styles.sectionTitle}>シナリオ</h2>
        {conflict && <span className={styles.conflictBadge}>他の変更あり</span>}
      </div>
      {editable ? (
        <>
          <textarea
            className={styles.scenarioInput}
            value={value}
            rows={4}
            maxLength={1200}
            aria-label="シナリオを編集"
            placeholder="お題のせつめいを書いてね（全員に同じものが見えます）"
            onChange={(e) => onEdit(e.target.value)}
          />
          <div className={styles.scenarioButtons}>
            <button
              type="button"
              className={styles.presetButton}
              data-testid="scenario-preset"
              onClick={() => setPicking(true)}
            >
              お題をえらぶ
            </button>
          </div>
          {picking && (
            <Dialog
              label="お題をえらぶ"
              onClose={() => setPicking(false)}
              testId="scenario-preset-dialog"
            >
              <h2 className={styles.dialogTitle} data-autofocus tabIndex={-1}>
                お題をえらぶ
              </h2>
              <ul className={styles.presetList}>
                {SCENARIO_PRESETS.map((preset) => (
                  <li key={preset}>
                    <button
                      type="button"
                      className={styles.presetOption}
                      onClick={() => {
                        onEdit(preset);
                        setPicking(false);
                      }}
                    >
                      {preset}
                    </button>
                  </li>
                ))}
              </ul>
              <div className={styles.dialogButtons}>
                <button type="button" onClick={() => setPicking(false)}>
                  やめる
                </button>
              </div>
            </Dialog>
          )}
        </>
      ) : (
        <p className={styles.scenarioRead}>
          {value.trim() === "" ? "（ホストがシナリオを書いています）" : value}
        </p>
      )}
    </section>
  );
}
