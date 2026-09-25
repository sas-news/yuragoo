// Synchronized in-game screen (Task 24/28, arena pass in the feedback
// round): the shared /play composition — creature center stage, seats on
// their attractor posts, post bubbles, HUD strip, corner event log, and
// the bottom-attached input tray — driven entirely by the server-folded
// RoomView. Every post, pull and outcome here came off the wire; nothing
// in this file fabricates game authority.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CreatureRuntime } from "@yuragoo/creature";
import arena from "../game/arena.module.css";
import { BubbleLayer } from "../game/BubbleLayer";
import { CreatureStage } from "../game/CreatureStage";
import { GameHud } from "../game/GameHud";
import feedStyles from "../game/MessageFeed.module.css";
import { PlayerSeats } from "../game/PlayerSeats";
import { ScenarioStrip } from "../game/ScenarioStrip";
import { useSeatAnchors } from "../game/seats";
import { SLOT_SYMBOLS } from "../game/slots";
import { usePostReaction } from "../game/usePostReaction";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import uiStyles from "../ui/ui.module.css";
import { useVisualViewportHeight } from "../ui/useVisualViewport";
import { latestRoomDist, roomEventLine, roomGoals, roomHud, roomSamples } from "./room-arena";
import { RoomDock } from "./RoomDock";
import type { RoomView } from "./room-view";
import { memberName } from "./view-members";
import styles from "./RoomGame.module.css";

interface RoomGameProps {
  readonly view: RoomView;
  readonly selfId: string;
  readonly submitText: (text: string) => Promise<unknown> | undefined;
  readonly pass: () => Promise<unknown> | undefined;
  // Any member may send everyone back to the lobby — the server only
  // requires a finished game. One player's click never restarts a match.
  readonly backToLobby: () => Promise<unknown> | undefined;
}

export function RoomGame({ view, selfId, submitText, pass, backToLobby }: RoomGameProps) {
  // IME fallback (Task 27): shrink to the visual viewport so the dock
  // stays under the software keyboard.
  const vvHeight = useVisualViewportHeight();
  const pageStyle = vvHeight === undefined ? undefined : { blockSize: `${vvHeight}px` };
  const arenaRef = useRef<HTMLDivElement | null>(null);
  const [runtime, setRuntime] = useState<CreatureRuntime | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(false);
  const [lobbyBusy, setLobbyBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const seenOutcomeRef = useRef<RoomView["outcome"]>(null);
  const reopenRef = useRef<HTMLButtonElement | null>(null);
  const feedRef = useRef<HTMLUListElement | null>(null);

  const outcome = view.outcome;
  if (seenOutcomeRef.current !== outcome) {
    seenOutcomeRef.current = outcome;
    if (outcome !== null && dismissed) setDismissed(false);
  }

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, []);

  // The corner log autoscrolls to the newest line like the /play feed.
  useEffect(() => {
    const list = feedRef.current;
    if (list !== null && view.feed.length > 0) list.scrollTop = list.scrollHeight;
  }, [view.feed]);

  const nameOf = (id: string): string => memberName(view.players, id);
  const seats = useSeatAnchors(view.roster, runtime, arenaRef);
  const presentation = useMemo(
    () => ({
      samples: roomSamples(latestRoomDist(view), view),
      expression: "rest" as const,
      reducedMotion: false,
    }),
    [view],
  );
  const { stageState, presentation: reacted } = usePostReaction(
    view.posts,
    view.roster,
    presentation,
  );
  const hud = roomHud(view);
  // TURN pulses the acting seat; LIVE has no order, so your own seat is
  // the highlighted one (the identity cue, not a turn claim).
  const currentId = hud.mode === "turn" ? view.turn?.playerId : selfId;
  const winner = outcome?.kind === "winner" ? memberName(view.players, outcome.playerId) : null;

  return (
    <main className={arena.page} style={pageStyle} data-testid="room-game">
      <h1 className="sr-only">ゆらぐー！</h1>
      <h2 className="sr-only">試合中</h2>
      <div className={arena.arena} ref={arenaRef}>
        <div className={arena.stageWrap}>
          <CreatureStage
            visualState={stageState}
            presentation={reacted}
            backgroundAlpha={0}
            onReady={setRuntime}
          />
        </div>
        {view.lobby.scenario.trim() !== "" && <ScenarioStrip>{view.lobby.scenario}</ScenarioStrip>}
        <div className={arena.hudWrap}>
          <GameHud
            state={hud}
            youId={selfId}
            now={now + view.clockOffset}
            nameOf={nameOf}
            hideDeadline
          />
        </div>
        <PlayerSeats
          roster={view.roster}
          positions={seats}
          currentId={currentId}
          nameOf={nameOf}
          goals={roomGoals(view)}
        />
        <BubbleLayer posts={view.posts} roster={view.roster} seats={seats} />
        <div className={arena.feedWrap}>
          <ul
            ref={feedRef}
            className={feedStyles.list}
            data-testid="event-feed"
            aria-label="イベント"
          >
            {view.feed.map((env) => (
              <li
                key={`${env.eventSeq}-${env.type}`}
                className={feedStyles.item}
                data-testid="feed-line"
              >
                {roomEventLine(env, view)}
              </li>
            ))}
          </ul>
        </div>
        {outcome !== null &&
          (dismissed ? (
            <Button
              className={uiStyles.reopen}
              ref={reopenRef}
              data-testid="outcome-reopen"
              onClick={() => setDismissed(false)}
            >
              けっかをみる
            </Button>
          ) : (
            <Dialog
              label="結果"
              veil="dark"
              testId="room-outcome"
              onClose={() => setDismissed(true)}
              returnFocus={() => reopenRef.current}
            >
              <h2 className={styles.title} data-autofocus tabIndex={-1}>
                結果
              </h2>
              {outcome.kind === "winner" && (
                <p className={styles.outcomeText}>
                  {SLOT_SYMBOLS[outcome.slot] ?? "?"} {winner ?? "？"} の勝ち！
                </p>
              )}
              {outcome.kind === "draw" && <p className={styles.outcomeText}>引き分け</p>}
              {outcome.kind === "noContest" && (
                <p className={styles.outcomeText}>無効試合（{outcome.reason}）</p>
              )}
              <div className={styles.dialogButtons}>
                <Button
                  variant="primary"
                  data-testid="back-to-lobby"
                  disabled={lobbyBusy}
                  onClick={() => {
                    setLobbyBusy(true);
                    void backToLobby()
                      ?.then(() => setLobbyBusy(false))
                      .catch((e: Error) => {
                        setLobbyBusy(false);
                        setSendError(e.message);
                      });
                  }}
                >
                  ロビーにもどる
                </Button>
                <Button onClick={() => setDismissed(true)}>とじる</Button>
              </div>
            </Dialog>
          ))}
      </div>
      {view.phase === "playing" && (
        <RoomDock
          view={view}
          selfId={selfId}
          now={now + view.clockOffset}
          submitText={submitText}
          pass={pass}
        />
      )}
      {sendError !== null && (
        <p className={styles.errorNote} role="alert">
          {sendError}
        </p>
      )}
    </main>
  );
}
