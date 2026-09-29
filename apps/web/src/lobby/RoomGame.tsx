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
import { PullCue } from "../game/PullCue";
import { ScenarioStrip } from "../game/ScenarioStrip";
import { useSeatAnchors } from "../game/seats";
import { usePostReaction } from "../game/usePostReaction";
import { useVisualViewportHeight } from "../ui/useVisualViewport";
import { Results } from "../results/Results";
import {
  committedCount,
  latestRoomDist,
  latestRoomMood,
  roomEventLine,
  roomGoals,
  roomHud,
  roomSamples,
} from "./room-arena";
import { expressionFor } from "./room-expression";
import { RoomDock } from "./RoomDock";
import type { RoomView } from "./room-view";
import { useOutcomeReveal } from "./useOutcomeReveal";
import { memberName } from "./view-members";

interface RoomGameProps {
  readonly view: RoomView;
  readonly selfId: string;
  readonly submitText: (text: string) => Promise<unknown> | undefined;
  readonly pass: () => Promise<unknown> | undefined;
  // Any member may send everyone back to the lobby — the server only
  // requires a finished game. One player's click never restarts a match.
  readonly backToLobby: () => Promise<unknown> | undefined;
  // Host-only room close — the results dialog confirms before sending.
  readonly closeRoom: () => Promise<unknown> | undefined;
}

export function RoomGame({
  view,
  selfId,
  submitText,
  pass,
  backToLobby,
  closeRoom,
}: RoomGameProps) {
  // IME fallback (Task 27): shrink to the visual viewport so the dock
  // stays under the software keyboard.
  const vvHeight = useVisualViewportHeight();
  const pageStyle = vvHeight === undefined ? undefined : { blockSize: `${vvHeight}px` };
  const arenaRef = useRef<HTMLDivElement | null>(null);
  const [runtime, setRuntime] = useState<CreatureRuntime | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const feedRef = useRef<HTMLUListElement | null>(null);

  const outcome = view.outcome;
  // Task 40: the dialog waits a beat — the veil carries the suspense.
  const reveal = useOutcomeReveal(outcome);
  // The seat the latest verdict pulled toward (pulse on the chip too).
  const [pulledId, setPulledId] = useState<string | undefined>(undefined);

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
  const presentation = useMemo(() => {
    const dist = latestRoomDist(view);
    const newest = view.posts[view.posts.length - 1];
    // postedAtMs is server-clock; the tick clock is local — shift by the offset.
    const idleMs =
      newest === undefined ? 0 : Math.max(0, now + view.clockOffset - newest.postedAtMs);
    return {
      samples: roomSamples(dist, view),
      expression: expressionFor(
        dist,
        latestRoomMood(view),
        committedCount(view),
        idleMs,
        view.turn?.round ?? 0,
      ),
      reducedMotion: false,
    };
  }, [view, now]);
  const { stageState, presentation: reacted } = usePostReaction(
    view.posts,
    view.roster,
    presentation,
  );
  const hud = roomHud(view);
  // TURN pulses the acting seat; LIVE has no order, so your own seat is
  // the highlighted one (the identity cue, not a turn claim).
  const currentId = hud.mode === "turn" ? view.turn?.playerId : selfId;

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
          pulledId={pulledId}
          avatarOf={(id) => view.players.find((p) => p.playerId === id)?.avatarUrl ?? undefined}
        />
        <PullCue view={view} seats={seats} onPulled={setPulledId} />
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
        {reveal.showingVeil && (
          <div className={arena.revealVeil} data-testid="results-reveal" role="status">
            <span>さあ、けっかは…</span>
          </div>
        )}
        {outcome !== null && reveal.revealed && (
          <Results
            view={view}
            isHost={view.hostPlayerId === selfId}
            backToLobby={backToLobby}
            closeRoom={closeRoom}
          />
        )}
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
    </main>
  );
}
