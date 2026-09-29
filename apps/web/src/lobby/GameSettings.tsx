// The shared game settings panel (Task 26): the mode, the mode-relevant
// durations and the two optional early-end switches — identical on every
// member's screen. The host edits through the normal updateLobby command;
// members see the same controls read-only. The server's lobbyChanged
// (new view; ready flags cleared only when the mode moved) is the only
// truth this panel renders — nothing is applied optimistically.
import type { LobbySettings, LobbySettingsView } from "@yuragoo/protocol";
import styles from "./Lobby.module.css";

interface GameSettingsProps {
  readonly settings: LobbySettingsView;
  readonly editable: boolean;
  readonly onChange: (patch: LobbySettings) => Promise<unknown> | undefined;
  readonly onError: (message: string) => void;
}

interface SegmentedProps<T extends string | number> {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly editable: boolean;
  readonly onPick: (value: T) => void;
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  editable,
  onPick,
}: SegmentedProps<T>) {
  return (
    <fieldset className={styles.field}>
      <legend className={styles.fieldLabel}>{label}</legend>
      <div className={styles.segmented}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            className={styles.segment}
            aria-pressed={o.value === value}
            disabled={!editable}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const MODES = [
  { value: "turn" as const, label: "じゅんばん" },
  { value: "live" as const, label: "いっせいに" },
];
const TURN_SECONDS = ([10, 20, 30, 45, 60] as const).map((v) => ({ value: v, label: `${v}秒` }));
const ROUNDS = ([1, 2, 3, 4, 5, 6, 8] as const).map((v) => ({ value: v, label: `${v}` }));
// Long sittings: the live menu jumps to minutes past 3 — a 10-minute
// round is a real "のんびり" session, not a typo for 600秒.
const LIVE_SECONDS = (
  [
    [60, "60秒"],
    [120, "120秒"],
    [180, "180秒"],
    [300, "5分"],
    [600, "10分"],
  ] as const
).map(([value, label]) => ({ value, label }));

export function GameSettings({ settings, editable, onChange, onError }: GameSettingsProps) {
  const send = (patch: LobbySettings): void => {
    void onChange(patch)?.catch((e: Error) => onError(e.message));
  };
  return (
    <section className={styles.plate} data-settings="panel">
      <div className={styles.plateHeader}>
        <h2 className={styles.sectionTitle}>ゲーム設定</h2>
        {!editable && <span className={styles.badge}>全員に表示</span>}
      </div>

      <Segmented
        label="モード"
        options={MODES}
        value={settings.mode}
        editable={editable}
        onPick={(mode) => send({ mode })}
      />
      {settings.mode === "turn" ? (
        <>
          <Segmented
            label="ラウンド数"
            options={ROUNDS}
            value={settings.rounds}
            editable={editable}
            onPick={(rounds) => send({ rounds })}
          />
          <Segmented
            label="1ターンの時間"
            options={TURN_SECONDS}
            value={settings.turnSeconds}
            editable={editable}
            onPick={(turnSeconds) => send({ turnSeconds })}
          />
        </>
      ) : (
        <Segmented
          label="試合の時間"
          options={LIVE_SECONDS}
          value={settings.liveSeconds}
          editable={editable}
          onPick={(liveSeconds) => send({ liveSeconds })}
        />
      )}

      {(
        [
          [
            "earlyDecision",
            "早期決着 — 強い流れが続くと試合が早めに終わります",
            () => send({ earlyDecision: !settings.earlyDecision }),
          ],
          [
            "hostDecision",
            "ホスト決着 — ホストが試合の終了を宣言できます",
            () => send({ hostDecision: !settings.hostDecision }),
          ],
        ] as const
      ).map(([key, caption, toggle]) => (
        <div className={styles.field} key={key}>
          <span className={styles.fieldLabel}>{caption}</span>
          <button
            type="button"
            className={styles.toggle}
            // オン/オフ alone is ambiguous — the caption joins the name.
            aria-label={`${caption.split(" — ")[0]}：${settings[key] ? "オン" : "オフ"}`}
            aria-pressed={settings[key]}
            disabled={!editable}
            onClick={toggle}
          >
            {settings[key] ? "オン" : "オフ"}
          </button>
        </div>
      ))}

      <p className={styles.note}>
        この設定は全員に表示されます。モードを変えると全員の準備OKがリセットされます。
      </p>
    </section>
  );
}
