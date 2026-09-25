// Per-seat choice rows (Task 24). Row i is publicly assigned to the i-th
// seated member (joinOrder order); rows past the member count are orphan
// drafts — dimmed, still host-editable, and re-activated automatically
// when the roster regrows. Choice identity is symbol + letter + assignee,
// never color alone.
import type { CSSProperties } from "react";
import type { LobbyState, RoomPlayerView } from "@yuragoo/protocol";
import { SLOT_LETTERS, SLOT_SYMBOLS, slotColor } from "../game/slots";
import styles from "./ChoiceEditor.module.css";
import shared from "./Lobby.module.css";

interface ChoiceEditorProps {
  readonly lobby: LobbyState;
  readonly members: readonly RoomPlayerView[];
  readonly editable: boolean;
  readonly drafts: Record<string, { value: string; conflict: boolean }>;
  readonly onEdit: (choiceId: string, value: string) => void;
}

const memberName = (p: RoomPlayerView | undefined, index: number): string =>
  p?.displayName ?? `プレイヤー${index + 1}`;

export function ChoiceEditor({ lobby, members, editable, drafts, onEdit }: ChoiceEditorProps) {
  const activeCount = members.length;
  return (
    <section className={shared.plate} aria-label="選択肢">
      <h2 className={shared.sectionTitle}>選択肢（メンバーに公開）</h2>
      <ul className={styles.choiceList}>
        {lobby.choices.map((choice, i) => {
          const orphan = i >= activeCount;
          const assignee = orphan ? undefined : members[i];
          const draft = drafts[choice.choiceId];
          const value = draft?.value ?? choice.label;
          const seat = `${SLOT_SYMBOLS[i] ?? "?"}${SLOT_LETTERS[i] ?? "?"}`;
          // Non-color identity for the whole row (Task 27): the accessible
          // name carries symbol + letter + label + assignee — color is a
          // redundant accent only.
          const rowName = `${seat}：${orphan ? "空き" : memberName(assignee, i)}の選択肢「${
            value === "" ? "未入力" : value
          }」`;
          return (
            <li
              key={choice.choiceId}
              className={orphan ? styles.choiceRowOrphan : styles.choiceRow}
              data-choice-id={choice.choiceId}
              data-orphan={orphan ? "true" : undefined}
              aria-label={rowName}
            >
              <span
                className={styles.slotBadge}
                style={{ "--slot-bg": slotColor(i) } as CSSProperties}
                aria-hidden="true"
              >
                {SLOT_SYMBOLS[i] ?? "?"}
              </span>
              <span className={styles.slotLetter}>{SLOT_LETTERS[i] ?? "?"}</span>
              <span className={styles.assignee}>
                {orphan ? "（空き）" : memberName(assignee, i)}
              </span>
              {editable ? (
                <input
                  className={styles.choiceInput}
                  value={value}
                  maxLength={60}
                  placeholder="選択肢を入力"
                  aria-label={`選択肢 ${seat}`}
                  onChange={(e) => onEdit(choice.choiceId, e.target.value)}
                />
              ) : (
                <span className={styles.choiceRead}>{value === "" ? "（未入力）" : value}</span>
              )}
              {draft?.conflict === true && (
                <span className={shared.conflictBadge}>他の変更あり</span>
              )}
            </li>
          );
        })}
        {lobby.choices.length === 0 && (
          <li className={shared.note}>メンバーが入ると選択肢ができます</li>
        )}
      </ul>
    </section>
  );
}
