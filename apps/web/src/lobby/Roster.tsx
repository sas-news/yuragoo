// The public roster chips (Task 24): display name, host mark, ready check,
// connection dot and the lobbyWaiting badge — every member sees the same
// list, in joinOrder. Task 27: dot/star/glyph states also render as
// screen-reader text — no state rides on color or a bare symbol alone.
import type { RoomView } from "./room-view";
import { memberName } from "./view-members";
import styles from "./Roster.module.css";

interface RosterProps {
  readonly view: RoomView;
  readonly selfId: string;
  // Host-only: hand the seat to another connected member. Rendered inside
  // each eligible chip; omitted entirely for non-host viewers.
  readonly onTransferHost?: ((playerId: string) => void) | undefined;
}

export function Roster({ view, selfId, onTransferHost }: RosterProps) {
  const ready = new Set(view.lobby.ready);
  return (
    <ul className={styles.roster} aria-label="メンバー">
      {view.players.map((p) => (
        <li
          key={p.playerId}
          className={styles.chip}
          data-player-id={p.playerId}
          data-ready={ready.has(p.playerId) ? "true" : undefined}
          data-host={p.playerId === view.hostPlayerId ? "true" : undefined}
          data-connected={p.connected ? "true" : undefined}
        >
          <span
            className={p.connected ? styles.dotOn : styles.dotOff}
            title={p.connected ? "接続中" : "切断"}
            aria-hidden="true"
          />
          <span className={styles.srOnly}>{p.connected ? "接続中" : "切断"}</span>
          <span className={styles.chipName} title={memberName(view.players, p.playerId)}>
            {memberName(view.players, p.playerId)}
            {p.playerId === selfId && <span className={styles.selfMark}>（あなた）</span>}
          </span>
          {p.playerId === view.hostPlayerId ? (
            <>
              <span className={styles.hostMark} title="ホスト" aria-hidden="true">
                ★
              </span>
              <span className={styles.srOnly}>ホスト</span>
            </>
          ) : (
            onTransferHost !== undefined &&
            p.connected && (
              <button
                type="button"
                className={styles.hostGive}
                data-testid={`host-give-${p.playerId}`}
                onClick={() => onTransferHost(p.playerId)}
              >
                ホストにする
              </button>
            )
          )}
          {p.lobbyWaiting ? (
            <span className={styles.waitBadge}>観戦待ち</span>
          ) : (
            <>
              <span
                className={ready.has(p.playerId) ? styles.readyOn : styles.readyOff}
                title={ready.has(p.playerId) ? "準備OK" : "未準備"}
                aria-hidden="true"
              >
                {ready.has(p.playerId) ? "✓" : "・"}
              </span>
              <span className={styles.srOnly}>{ready.has(p.playerId) ? "準備OK" : "未準備"}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
