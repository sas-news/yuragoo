// /play — the single-screen local match (Task 15). LocalSession is the host:
// it owns one LocalLoop (the imperative reducer/command/timer machine in
// loop.ts), exposes it to e2e as window.__localBridge, and renders LocalGame
// under key={epoch} so every rematch remounts the whole arena tree — old
// bubbles, reactions and seat effects can never leak into the new game.
// The loop itself is epoch-guarded: provider answers from an older epoch are
// dropped before they can touch state.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CreaturePresentation, CreatureRuntime, SceneLayoutSummary } from "@yuragoo/creature";
import type { GameAction, GameEvent, GamePhase, GameState } from "@yuragoo/game-core";
import type { DecisionDistribution } from "@yuragoo/protocol";
import { createSessionId } from "../dev/decision-providers";
import { LocalGame } from "./LocalGame";
import { createLocalLoop, type DockStatus, type LocalLoop } from "./loop";
import { selectEvaluate } from "./providers";
import { choicesFor, samplesFor } from "./scenario";
import { latestEvaluatedDist, type LocalSetup, parseLocalParams } from "./session";

export interface LocalBridge {
  state(): GameState | null;
  dispatch(action: GameAction): { phase: GamePhase | "none"; seq: number };
  epoch(): number;
  readonly events: readonly GameEvent[];
  layout(): SceneLayoutSummary | null;
  dists(): Record<string, readonly DecisionDistribution[]>;
  rematch(): void;
}

declare global {
  interface Window {
    __localBridge?: LocalBridge;
  }
}

export default function LocalSession() {
  const params = useMemo(() => parseLocalParams(window.location.search), []);
  const [setup, setSetup] = useState<LocalSetup>({
    players: params.players,
    mode: params.mode,
    seed: params.seed,
  });
  const [game, setGame] = useState<GameState | null>(null);
  const [status, setStatus] = useState<DockStatus>("idle");
  const runtimeRef = useRef<CreatureRuntime | null>(null);
  // The setup actually played — rematch replays these, not the panel edits.
  const playedSetupRef = useRef<LocalSetup>({
    players: params.players,
    mode: params.mode,
    seed: params.seed,
  });
  const sessionId = useMemo(createSessionId, []);
  const loopRef = useRef<LocalLoop | null>(null);
  if (loopRef.current === null) {
    loopRef.current = createLocalLoop({
      params,
      makeEvaluate: (rosterSize) => selectEvaluate(params, choicesFor(rosterSize), sessionId),
      onGame: setGame,
      onStatus: setStatus,
    });
  }
  const loop = loopRef.current;

  const start = (): void => {
    playedSetupRef.current = setup;
    loop.boot(setup);
  };

  // window.__localBridge — the e2e seam, mirroring __gameBridge conventions.
  useEffect(() => {
    window.__localBridge = {
      state: () => loop.state(),
      dispatch: (action) => {
        loop.dispatch(action);
        const s = loop.state();
        return { phase: s?.phase ?? "none", seq: s?.seq ?? 0 };
      },
      epoch: () => loop.epoch(),
      layout: () => {
        try {
          return runtimeRef.current?.readLayoutSummary() ?? null;
        } catch {
          return null; // stage remounting after an epoch bump
        }
      },
      dists: () => Object.fromEntries(loop.dists()),
      rematch: () => loop.rematch(playedSetupRef.current),
      get events() {
        return loop.events();
      },
    };
    return () => {
      delete window.__localBridge;
    };
  }, [loop]);

  useEffect(
    () => () => {
      runtimeRef.current = null;
      loop.dispose();
    },
    [loop],
  );

  // Creature base presentation: the newest evaluated distribution pulls the
  // attractors; before any eval lands the creature rests on a uniform ring.
  // usePostReaction (in LocalGame) layers the "聞いた" flicker on top.
  // Expression stays "rest" — the adhering ring was dropped (15b): early
  // decision is still tracked in the reducer (adhere bookkeeping) but no
  // longer performed on stage.
  const presentation = useMemo<CreaturePresentation>(() => {
    const rosterSize = game?.roster.length ?? 4;
    const dist = game === null ? null : latestEvaluatedDist(game.posts, loop.dists());
    return {
      samples: samplesFor(dist, rosterSize),
      expression: "rest",
      reducedMotion: false,
    };
  }, [game, loop]);

  return (
    <LocalGame
      key={loop.epoch()}
      game={game}
      status={status}
      presentation={presentation}
      setup={setup}
      onSetupChange={setSetup}
      onStart={start}
      onSubmit={(text, playerId) => loop.submit(text, playerId)}
      onRematch={() => loop.rematch(playedSetupRef.current)}
      onStageReady={(runtime) => {
        runtimeRef.current = runtime;
      }}
    />
  );
}
