// Dedicated PIP lobby (Task 48): the pop-out is a glance surface, not an
// editor — scenario one-liner, member dots, seat/readiness counts, and the
// two actions that matter (invite, ready/start). Editing, generation and
// settings stay on the focused layout; popping back restores them.
import { LOBBY_SEAT_COUNT } from "@yuragoo/protocol";
import { InviteButton } from "./InviteButton";
import { startGateReason } from "./lobby-gate";
import styles from "./PipLobby.module.css";
import type { RoomView } from "./room-view";
import { memberName, seatedMembers } from "./view-members";

interface PipLobbyProps {
  readonly view: RoomView;
  readonly selfId: string;
  readonly inviteUrl: string | null;
  readonly lastError: string | null;
  readonly setReady: (ready: boolean) => Promise<unknown> | undefined;
  readonly startGame: () => Promise<unknown> | undefined;
  readonly onLeave: () => void;
}

export function PipLobby({
  view,
  selfId,
  inviteUrl,
  lastError,
  setReady,
  startGame,
  onLeave,
}: PipLobbyProps) {
  const lobby = view.lobby;
  const members = seatedMembers(view);
  const isHost = view.hostPlayerId === selfId;
  const self = view.players.find((p) => p.playerId === selfId);
  const ready = lobby.ready.includes(selfId);
  const readyCount = members.filter((m) => lobby.ready.includes(m.playerId)).length;
  const gateReason = startGateReason(lobby, members);
  const scenario = lobby.scenario.trim();
  const error = lastError ?? (isHost ? view.generationError?.message : null) ?? null;

  return (
    <section className={styles.pip} aria-label="ロビー（簡易表示）">
      <p className={styles.scenario} title={scenario === "" ? undefined : scenario}>
        {scenario === "" ? "お題がまだありません" : scenario}
      </p>

      <ul className={styles.members} aria-label="メンバー">
        {members.map((p) => (
          <li
            key={p.playerId}
            className={styles.member}
            data-ready={lobby.ready.includes(p.playerId) ? "true" : undefined}
          >
            <span
              className={p.connected ? styles.dotOn : styles.dotOff}
              aria-hidden="true"
              title={p.connected ? "接続中" : "切断"}
            />
            <span className={styles.name} title={memberName(view.players, p.playerId)}>
              {memberName(view.players, p.playerId)}
            </span>
            {p.playerId === view.hostPlayerId && (
              <span className={styles.host} title="ホスト">
                ★<span className={styles.srOnly}>ホスト</span>
              </span>
            )}
            {lobby.ready.includes(p.playerId) && (
              <span className={styles.readyMark} title="準備OK">
                ✓<span className={styles.srOnly}>準備OK</span>
              </span>
            )}
          </li>
        ))}
      </ul>

      <p className={styles.status}>
        選択肢 {lobby.choices.length}/{LOBBY_SEAT_COUNT}席 ・ 準備 {readyCount}/{members.length}
      </p>

      <div className={styles.actions}>
        <InviteButton inviteUrl={inviteUrl} isHost={isHost} onError={() => {}} />
        {self?.lobbyWaiting === true ? (
          <p className={styles.note}>観戦待ち</p>
        ) : (
          <button type="button" aria-pressed={ready} onClick={() => void setReady(!ready)}>
            {ready ? "準備OK！" : "準備OKにする"}
          </button>
        )}
        {isHost ? (
          <button
            type="button"
            className={styles.primary}
            disabled={gateReason !== null}
            title={gateReason ?? undefined}
            onClick={() => void startGame()}
          >
            はじめる
          </button>
        ) : null}
        <button type="button" className={styles.leave} onClick={onLeave} aria-label="へやを出る">
          出る
        </button>
      </div>

      {isHost && gateReason !== null && <p className={styles.note}>{gateReason}</p>}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
