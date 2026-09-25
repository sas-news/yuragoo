// /dev/game harness (dev/e2e only — the route itself is gated in main.tsx).
// A fixed four-player TURN match (seed 7) runs through the real reduce()
// with a fake 300ms "evaluation" per post; the seat follows the current
// turn for same-screen handover. window.__gameBridge: snapshots, dispatch,
// layout, events.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CANONICAL_SLOT_ANGLES,
  type CreaturePresentation,
  type CreatureRuntime,
  type SceneLayoutSummary,
} from "@yuragoo/creature";
import {
  type GameAction,
  type GameEvent,
  type GamePhase,
  type GameState,
  type PlayerId,
  reduce,
} from "@yuragoo/game-core";
import { BubbleLayer } from "../game/BubbleLayer";
import { CreatureStage } from "../game/CreatureStage";
import { GameHud, type HudSnapshot } from "../game/GameHud";
import { InputDock } from "../game/InputDock";
import { MessageFeed } from "../game/MessageFeed";
import { PlayerSeats } from "../game/PlayerSeats";
import { useSeatAnchors } from "../game/seats";
import { slotColor } from "../game/slots";
import { usePostReaction } from "../game/usePostReaction";
import styles from "./GameDev.module.css";

const PLAYER_IDS = ["aiko", "ren", "yuu", "riku"] as const;
const NAMES: Readonly<Record<string, string>> = {
  aiko: "あいこ",
  ren: "れん",
  yuu: "ゆう",
  riku: "りく",
};
const nameOf = (id: PlayerId): string => NAMES[id] ?? id;

const SEED = 7;
const EVAL_DELAY_MS = 300;
// Long slots so a wall-clock deadline never fires mid-test.
const TURN_SECONDS = 300;

const GAME_PRESENTATION: CreaturePresentation = {
  samples: (CANONICAL_SLOT_ANGLES[4] ?? []).map((angleRad) => ({
    angleRad,
    weight: 0.25,
  })),
  expression: "rest",
  reducedMotion: false,
};

interface GameBridge {
  state(): GameState;
  dispatch(action: GameAction): { phase: GamePhase; seq: number };
  layout(): SceneLayoutSummary | null;
  readonly events: readonly GameEvent[];
}

declare global {
  interface Window {
    __gameBridge?: GameBridge;
  }
}

// Dev sandbox: free-range turnSeconds + both early-end switches on (Task 26).
const DEV_SETTINGS = {
  mode: "turn",
  seed: SEED,
  rosterSize: PLAYER_IDS.length,
  devMode: true,
  earlyDecision: true,
  hostDecision: true,
  turnSeconds: TURN_SECONDS,
} as const;

const bootGame = (): { state: GameState; events: GameEvent[] } => {
  const nowMs = Date.now();
  const created = reduce(null, {
    type: "create",
    settings: DEV_SETTINGS,
    playerIds: [...PLAYER_IDS],
    nowMs,
  });
  const started = reduce(created.state, { type: "start", nowMs });
  const events = [...created.commands, ...started.commands].flatMap((command) =>
    command.type === "publish" ? [command.event] : [],
  );
  return { state: started.state, events };
};

export default function GameDev() {
  const [initial] = useState(bootGame);
  const [game, setGame] = useState<GameState>(initial.state);
  const [status, setStatus] = useState<"idle" | "pending">("idle");
  const [now, setNow] = useState(() => Date.now());
  const [runtime, setRuntime] = useState<CreatureRuntime | null>(null);
  const stateRef = useRef<GameState>(initial.state);
  const eventsRef = useRef<GameEvent[]>(initial.events);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const runtimeRef = useRef<CreatureRuntime | null>(null);
  const arenaRef = useRef<HTMLDivElement | null>(null);
  // The runtime lands async: the ref feeds __gameBridge, the state re-renders seats.
  const onStageReady = useCallback((rt: CreatureRuntime): void => {
    runtimeRef.current = rt;
    setRuntime(rt);
  }, []);
  const seats = useSeatAnchors(game.roster, runtime, arenaRef);

  const dispatch = useCallback((action: GameAction): void => {
    const transition = reduce(stateRef.current, action);
    stateRef.current = transition.state;
    setGame(transition.state);
    for (const command of transition.commands) {
      if (command.type === "publish") {
        eventsRef.current = [...eventsRef.current, command.event];
      } else if (command.type === "evaluate") {
        const postId = command.postId;
        const timer = setTimeout(() => {
          timersRef.current.delete(timer);
          const post = stateRef.current.posts.find((p) => p.postId === postId);
          if (post?.status !== "pending") return;
          dispatch({ type: "evaluated", postId });
          setStatus("idle"); // ack: the dock clears its draft on pending->idle
        }, EVAL_DELAY_MS);
        timersRef.current.add(timer);
      } else if (command.type === "set-deadline" && command.tag === "settle") {
        const timer = setTimeout(
          () => {
            timersRef.current.delete(timer);
            if (stateRef.current.phase !== "complete") return;
            dispatch({ type: "settle-deadline", nowMs: Math.max(Date.now(), command.atMs) });
          },
          Math.max(0, command.atMs - Date.now()),
        );
        timersRef.current.add(timer);
      }
    }
  }, []);

  const submit = useCallback(
    (text: string): void => {
      const current = stateRef.current;
      if (current.phase !== "playing") return;
      const seat = current.turnOrder[current.turnIndex];
      if (seat === undefined) return;
      setStatus("pending");
      try {
        dispatch({ type: "post", playerId: seat, text, nowMs: Date.now() });
      } catch {
        // A rejected post emits nothing — release the dock so it can retry.
        setStatus("idle");
      }
    },
    [dispatch],
  );

  // One cleanup for every harness clock: pending eval timers + the HUD tick.
  useEffect(() => {
    const timers = timersRef.current;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearInterval(tick);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    window.__gameBridge = {
      state: () => stateRef.current,
      dispatch: (action) => {
        dispatch(action);
        const { phase, seq } = stateRef.current;
        return { phase, seq };
      },
      layout: () => runtimeRef.current?.readLayoutSummary() ?? null,
      get events() {
        return [...eventsRef.current];
      },
    };
    return () => void delete window.__gameBridge;
  }, [dispatch]);

  const pending = game.posts.some((p) => p.status === "pending");
  const canPost = game.phase === "playing" && !pending;
  const seat = game.phase === "playing" ? game.turnOrder[game.turnIndex] : undefined;
  const seatSlot = game.roster.find((p) => p.id === seat)?.slot;
  const disabledReason =
    game.phase !== "playing"
      ? "このゲームはおわったよ"
      : pending
        ? "こたえをかんがえちゅう…"
        : undefined;

  const { stageState, presentation } = usePostReaction(game.posts, game.roster, GAME_PRESENTATION);

  const hud: HudSnapshot = useMemo(
    () => ({
      phase: game.phase,
      mode: game.settings.mode,
      round: game.round,
      rounds: game.settings.rounds,
      turnOrder: game.turnOrder,
      turnIndex: game.turnIndex,
      roster: game.roster,
      deadlineAtMs: game.deadlineAtMs,
      outcome: game.outcome,
      windowMs:
        game.settings.mode === "turn"
          ? game.settings.turnSeconds * 1000
          : game.settings.liveSeconds * 1000,
    }),
    [game],
  );

  return (
    <main className={styles.page} data-testid="game-dev">
      <div className={styles.arena} ref={arenaRef}>
        <div className={styles.stageWrap}>
          <CreatureStage
            visualState={stageState}
            presentation={presentation}
            backgroundAlpha={0}
            onReady={onStageReady}
          />
        </div>
        <div className={styles.hudWrap}>
          <GameHud state={hud} youId={seat} now={now} nameOf={nameOf} />
        </div>
        <PlayerSeats roster={game.roster} positions={seats} currentId={seat} nameOf={nameOf} />
        <BubbleLayer posts={game.posts} roster={game.roster} seats={seats} />
        <div className={styles.feedWrap}>
          <MessageFeed posts={game.posts} roster={game.roster} nameOf={nameOf} />
        </div>
      </div>
      <InputDock
        canPost={canPost}
        status={status}
        disabledReason={disabledReason}
        seatLabel={seat === undefined ? undefined : `いまの席：${nameOf(seat)}`}
        sendColor={seatSlot === undefined ? undefined : slotColor(seatSlot)}
        onSubmit={submit}
      />
    </main>
  );
}
