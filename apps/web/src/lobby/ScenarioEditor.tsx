// The shared scenario field (Task 24). Host edits with debounced save;
// everyone else reads. `conflict` = a lobbyChanged landed on a different
// revision while this field held unsent/divergent text — non-blocking,
// the local draft wins until the server echoes it back.
import styles from "./Lobby.module.css";
import { pickScenarioPreset } from "./scenario-presets";

interface ScenarioEditorProps {
  readonly editable: boolean;
  readonly value: string;
  readonly conflict: boolean;
  readonly onEdit: (value: string) => void;
}

export function ScenarioEditor({ editable, value, conflict, onEdit }: ScenarioEditorProps) {
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
          <button
            type="button"
            className={styles.presetButton}
            data-testid="scenario-preset"
            onClick={() => onEdit(pickScenarioPreset(value))}
          >
            お題をえらぶ
          </button>
        </>
      ) : (
        <p className={styles.scenarioRead}>
          {value.trim() === "" ? "（ホストがシナリオを書いています）" : value}
        </p>
      )}
    </section>
  );
}
