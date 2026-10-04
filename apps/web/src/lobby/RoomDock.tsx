// Task 28: the room's playable input cluster — the shared InputDock tray
// with the TURN-mode パスする folded INSIDE it (nothing sits between the
// tray and the screen's bottom edge). Turn identity lives in the HUD and
// the dock's seat column; the e2e probes ride data-* on this wrapper.
// Rendered only while the room phase is "playing". Every send goes
// through the page's own RoomConnection: the UI never fabricates
// acceptance, the pending flag waits for the command ack, and the server
// stays the single authority on turns, text bounds and rejection.
import { useState } from "react";
import { InputDock } from "../game/InputDock";
import { commandErrorText } from "./lobby-errors";
import { slotColor } from "../game/slots";
import { roomHud } from "./room-arena";
import type { RoomView } from "./room-view";
import { memberName } from "./view-members";
import shared from "./Lobby.module.css";
import styles from "./RoomGame.module.css";

interface RoomDockProps {
  readonly view: RoomView;
  readonly selfId: string;
  // Server-clock "now" — the draining bar over the tray reads it so the
  // countdown can't skew against the server deadline.
  readonly now: number;
  readonly submitText: (text: string) => Promise<unknown> | undefined;
  readonly pass: () => Promise<unknown> | undefined;
}

const nameOf = (view: RoomView, id: string | undefined): string =>
  id === undefined ? "だれか" : memberName(view.players, id);

export function RoomDock({ view, selfId, now, submitText, pass }: RoomDockProps) {
  const mode = view.lobby.settings.mode;
  const turn = view.turn;
  const myTurn = turn !== null && turn.playerId === selfId;
  const inRoster = view.roster.some((r) => r.id === selfId);
  const [status, setStatus] = useState<"idle" | "pending">("idle");
  const [error, setError] = useState<string | null>(null);
  // The turn the last accepted post/pass belongs to — closes the gap
  // between the ack and the next "turn" event so a fast double click
  // can never fire a second command the server would have to refuse.
  const [spentKey, setSpentKey] = useState<string | null>(null);
  const turnKey = turn === null ? null : `${turn.round}:${turn.playerId}`;
  const spentThisTurn = turnKey !== null && spentKey === turnKey;

  // Who the dock speaks for: the turn player in TURN, myself in LIVE.
  const actingId = mode === "turn" ? turn?.playerId : selfId;
  const actingSlot = view.roster.find((r) => r.id === actingId)?.slot;
  const goal = actingSlot === undefined ? undefined : view.lobby.choices[actingSlot]?.label;

  const canPost = inRoster && !spentThisTurn && (mode === "live" || myTurn);
  const disabledReason = !inRoster
    ? "観戦中です"
    : spentThisTurn
      ? "うけつけました"
      : mode === "turn" && !myTurn
        ? `${nameOf(view, turn?.playerId)} のターンです`
        : undefined;

  const settle = (send: Promise<unknown> | undefined): void => {
    setStatus("pending");
    setError(null);
    void send
      ?.then(() => {
        setSpentKey(turnKey);
        setStatus("idle");
      })
      .catch((e: Error) => {
        setStatus("idle");
        setError(commandErrorText(e));
      });
  };

  const hud = roomHud(view);
  // The remaining-time display the user asked for near the input: a thin
  // draining bar riding just under the tray's bottom edge — the rim under
  // the box is gone, the bar IS the bottom edge (no numeric seconds).
  const ratio =
    hud.windowMs > 0 ? Math.min(1, Math.max(0, (hud.deadlineAtMs - now) / hud.windowMs)) : 0;

  return (
    <div
      className={styles.dockZone}
      data-testid="room-dock"
      data-turn-player={turn?.playerId}
      data-turn-round={turn?.round}
      data-turn-self={myTurn || undefined}
    >
      <InputDock
        flushBottom
        canPost={canPost}
        status={status}
        deadlineAtMs={canPost ? hud.deadlineAtMs : undefined}
        nowMs={canPost ? now : undefined}
        disabledReason={disabledReason}
        seatLabel={actingId === undefined ? undefined : `いまの席：${nameOf(view, actingId)}`}
        goalLabel={goal === undefined || goal === "" ? undefined : goal}
        sendColor={actingSlot === undefined ? undefined : slotColor(actingSlot)}
        trailing={
          mode === "turn" && myTurn && !spentThisTurn ? (
            <button
              type="button"
              className={styles.passButton}
              disabled={status === "pending"}
              onClick={() => settle(pass())}
            >
              パスする
            </button>
          ) : undefined
        }
        onSubmit={(text) => settle(submitText(text))}
      />
      <div
        className={styles.dockDeadline}
        role="progressbar"
        aria-label="残り時間"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div
          className={styles.dockDeadlineFill}
          data-testid="deadline-bar"
          style={{ inlineSize: `${ratio * 100}%` }}
        />
      </div>
      {error !== null && (
        <p className={shared.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
