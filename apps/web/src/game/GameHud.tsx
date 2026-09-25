// Non-numeric game HUD: who plays (roster chips with the player's attractor
// slot badge), whose turn it is, which round, and how much of the slot is
// left — a thin draining bar. Probabilities are still the creature's body
// language, not UI numbers (確率は身体で見せる).
import type { CSSProperties } from "react";
import type { PlayerId } from "@yuragoo/game-core";
import type { HudSnapshot } from "./hud-types";
import styles from "./GameHud.module.css";
import { slotBadge, slotColor } from "./slots";

export type { HudSnapshot } from "./hud-types";

export interface GameHudProps {
  readonly state: HudSnapshot;
  readonly youId?: PlayerId | undefined;
  readonly now?: number | undefined;
  readonly nameOf?: ((id: PlayerId) => string) | undefined;
  // The room screen moves the draining bar onto the input dock (近くで見せる)
  // — /play and the labs keep it in the strip.
  readonly hideDeadline?: boolean | undefined;
}

const turnPlayerId = (state: HudSnapshot): PlayerId | undefined => state.turnOrder[state.turnIndex];

const turnLine = (state: HudSnapshot, nameOf: (id: PlayerId) => string): string => {
  switch (state.phase) {
    case "lobby":
      return "ロビーで待機中";
    case "complete":
      return "結果をまとめています";
    case "finished": {
      const outcome = state.outcome;
      if (outcome?.kind === "winner") return `${nameOf(outcome.playerId)} の勝ち！`;
      if (outcome?.kind === "draw") return "引き分け";
      return "今回は不成立";
    }
    case "playing": {
      if (state.mode === "live") return "みんなで投稿ちゅう";
      const current = turnPlayerId(state);
      return current === undefined ? "…" : `${nameOf(current)} の番です`;
    }
  }
};

export function GameHud(props: GameHudProps) {
  const { state, youId, nameOf = (id) => id } = props;
  const now = props.now ?? Date.now();
  const current = turnPlayerId(state);

  const counting = state.phase === "playing" || state.phase === "complete";
  const ratio =
    counting && state.windowMs > 0
      ? Math.min(1, Math.max(0, (state.deadlineAtMs - now) / state.windowMs))
      : 0;

  return (
    <section className={styles.hud} aria-label="ゲーム状況">
      <div className={styles.topRow}>
        <p className={styles.turnLine} data-testid="turn-line">
          {turnLine(state, nameOf)}
        </p>
        {state.mode === "turn" && state.phase === "playing" ? (
          <span className={styles.round} data-testid="round-line">
            {state.round + 1}回戦（全{state.rounds}回）
          </span>
        ) : null}
        <ul className={styles.roster} aria-label="プレイヤー">
          {state.roster.map((player) => {
            const isTurn =
              state.phase === "playing" && state.mode === "turn" && player.id === current;
            const badge = slotBadge(player.slot);
            return (
              <li
                key={player.id}
                className={styles.chip}
                data-current={isTurn || undefined}
                data-testid="roster-chip"
                aria-label={`${nameOf(player.id)} — 担当 ${badge}`}
              >
                <span
                  className={styles.slotChip}
                  style={{ "--slot-bg": slotColor(player.slot) } as CSSProperties}
                  aria-hidden="true"
                >
                  {badge}
                </span>
                <span className={styles.name} title={nameOf(player.id)}>
                  {nameOf(player.id)}
                  {player.id === youId ? "（あなた）" : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {props.hideDeadline !== true && (
        <div
          className={styles.deadline}
          role="progressbar"
          aria-label="残り時間"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <div
            className={styles.deadlineFill}
            data-testid="deadline-bar"
            style={{ inlineSize: `${ratio * 100}%` }}
          />
        </div>
      )}
    </section>
  );
}
