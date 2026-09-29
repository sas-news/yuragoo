// The shared scenario field (Task 24). Host edits with debounced save;
// everyone else reads. `conflict` = a lobbyChanged landed on a different
// revision while this field held unsent/divergent text — non-blocking,
// the local draft wins until the server echoes it back.
// Task 44: `generation` carries the host-only AI お題 UI (one-shot slot,
// proposal applies through the normal revision-gated edit).
import styles from "./Lobby.module.css";
import { pickScenarioPreset } from "./scenario-presets";
import type { ScenarioGenerationUi } from "./use-scenario-generation";

interface ScenarioEditorProps {
  readonly editable: boolean;
  readonly value: string;
  readonly conflict: boolean;
  readonly onEdit: (value: string) => void;
  readonly generation: ScenarioGenerationUi | undefined;
}

export function ScenarioEditor({
  editable,
  value,
  conflict,
  onEdit,
  generation,
}: ScenarioEditorProps) {
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
              onClick={() => onEdit(pickScenarioPreset(value))}
            >
              お題をえらぶ
            </button>
            {generation !== undefined && (
              <button
                type="button"
                className={styles.presetButton}
                data-testid="scenario-generate"
                disabled={generation.spent || generation.busy}
                onClick={generation.onGenerate}
              >
                AIでお題をつくる{" "}
                {generation.spent ? (
                  <span className={styles.badge}>生成済み</span>
                ) : (
                  generation.busy && <span className={styles.badge}>生成中…</span>
                )}
              </button>
            )}
          </div>
          {generation !== undefined && generation.proposal !== null && (
            <div className={styles.plate}>
              <h3 className={styles.sectionTitle}>AIのお題案</h3>
              {generation.proposal.lobbyRevision !== generation.currentRevision && (
                <p className={styles.note}>生成したあとにロビーが変更されています</p>
              )}
              <p className={styles.scenarioRead} data-proposal-scenario>
                {generation.proposal.scenario}
              </p>
              <div className={styles.proposalButtons}>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={generation.onApply}
                  data-testid="scenario-proposal-apply"
                >
                  このお題にする
                </button>
                <button type="button" onClick={generation.onDismiss}>
                  やめる
                </button>
              </div>
            </div>
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
