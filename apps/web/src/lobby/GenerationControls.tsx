// Task 25 host-only generation controls: the trigger button (regenerates
// freely — "もう一度生成" once a proposal has landed; 生成中… while in
// flight) and the proposal plate the host applies, rerolls or dismisses.
// Lobby renders this only for the host — members never see any of it.
import { useT } from "../i18n";
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
  const t = useT();
  return (
    <>
      <button
        type="button"
        className={styles.aiButton}
        disabled={busy || scenarioEmpty}
        onClick={onGenerate}
      >
        {spent ? t("もう一度生成") : t("AIで選択肢を生成")}{" "}
        {busy && <span className={styles.badge}>{t("生成中…")}</span>}
      </button>
      {scenarioEmpty && <p className={styles.note}>{t("シナリオを入力すると生成できます")}</p>}
      {proposal !== null && (
        <section className={styles.plate} aria-label={t("AIの生成案")}>
          <h2 className={styles.sectionTitle}>{t("AIの生成案")}</h2>
          {proposal.lobbyRevision !== currentRevision && (
            <p className={styles.note}>{t("生成したあとにロビーが変更されています")}</p>
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
              {t("生成案を適用")}
            </button>
            <button type="button" disabled={busy} onClick={onGenerate}>
              {t("もう一度生成")}
            </button>
            <button type="button" onClick={onDismiss}>
              {t("やめる")}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
