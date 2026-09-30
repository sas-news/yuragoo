// Task 25 host-only generation controls: the one-shot trigger button
// (disabled + 生成済み once the slot is spent, 生成中… while the request
// is in flight) and the proposal plate the host applies or dismisses.
// Lobby renders this only for the host — members never see any of it.
import type { ChoiceProposal } from "./room-view";
import styles from "./Lobby.module.css";

interface Props {
  readonly spent: boolean;
  readonly busy: boolean;
  // Server rejects generation on an empty scenario — gate the click and
  // say why instead of letting the rejection toast carry English.
  readonly scenarioEmpty: boolean;
  readonly proposal: ChoiceProposal | null;
  readonly currentRevision: number;
  readonly onGenerate: () => void;
  readonly onApply: () => void;
  readonly onDismiss: () => void;
}

export function GenerationControls({
  spent,
  busy,
  scenarioEmpty,
  proposal,
  currentRevision,
  onGenerate,
  onApply,
  onDismiss,
}: Props) {
  return (
    <>
      <button
        type="button"
        className={styles.aiButton}
        disabled={spent || busy || scenarioEmpty}
        onClick={onGenerate}
      >
        AIで選択肢を生成{" "}
        {spent ? (
          <span className={styles.badge}>生成済み</span>
        ) : (
          busy && <span className={styles.badge}>生成中…</span>
        )}
      </button>
      {scenarioEmpty && !spent && <p className={styles.note}>シナリオを入力すると生成できます</p>}
      {proposal !== null && (
        <section className={styles.plate} aria-label="AIの生成案">
          <h2 className={styles.sectionTitle}>AIの生成案</h2>
          {proposal.lobbyRevision !== currentRevision && (
            <p className={styles.note}>生成したあとにロビーが変更されています</p>
          )}
          <ul className={styles.proposalList}>
            {proposal.labels.map((label) => (
              // Server-validated distinct — safe as the element key.
              <li key={label} data-proposal-label>
                {label}
              </li>
            ))}
          </ul>
          <div className={styles.proposalButtons}>
            <button type="button" className={styles.primary} onClick={onApply}>
              生成案を適用
            </button>
            <button type="button" onClick={onDismiss}>
              やめる
            </button>
          </div>
        </section>
      )}
    </>
  );
}
