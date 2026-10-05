// The /play view (Task 15): same visual language and composition as the
// /dev/game harness — creature center stage on the flat paper world, seat
// chips on their attractor posts, post bubbles, HUD strip, feed, input dock.
// Differences: a setup card while there is no game, a click-to-act seat
// picker in LIVE mode (TURN follows turnOrder), and the result overlay with
// もう一回. The host loop lives in LocalSession/loop.ts; this file is pure
// view + the acting-seat state.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CreaturePresentation, CreatureRuntime } from "@yuragoo/creature";
import type { GameState, PlayerId } from "@yuragoo/game-core";
import { BubbleLayer } from "../game/BubbleLayer";
import { CreatureStage } from "../game/CreatureStage";
import { GameHud, type HudSnapshot } from "../game/GameHud";
import { InputDock } from "../game/InputDock";
import { MessageFeed } from "../game/MessageFeed";
import { PlayerSeats } from "../game/PlayerSeats";
import { ScenarioStrip } from "../game/ScenarioStrip";
import { useSeatAnchors } from "../game/seats";
import { slotColor } from "../game/slots";
import { usePostReaction } from "../game/usePostReaction";
import { useVisualViewportHeight } from "../ui/useVisualViewport";
import { useLocale, useT } from "../i18n";
import arena from "../game/arena.module.css";
import { LocalResult } from "./LocalResult";
import { LocalSetupPanel } from "./LocalSetup";
import { choicesFor, localNameOf, localPersona, localScenario } from "./scenario";
import type { DockStatus } from "./loop";
import type { LocalSetup } from "./session";

export interface LocalGameProps {
  readonly game: GameState | null;
  readonly status: DockStatus;
  readonly presentation: CreaturePresentation;
  readonly setup: LocalSetup;
  readonly onSetupChange: (setup: LocalSetup) => void;
  readonly onStart: () => void;
  readonly onSubmit: (text: string, playerId: PlayerId) => void;
  readonly onRematch: () => void;
  readonly onStageReady: (runtime: CreatureRuntime) => void;
}

export function LocalGame(props: LocalGameProps) {
  const { game } = props;
  // IME fallback (Task 27): shrink the page to the visual viewport when a
  // software keyboard occludes the layout viewport (100dvh misses it).
  const vvHeight = useVisualViewportHeight();
  const pageStyle = vvHeight === undefined ? undefined : { blockSize: `${vvHeight}px` };
  if (game === null) {
    return (
      <main className={arena.page} style={pageStyle} data-testid="local-game">
        <LocalSetupPanel
          setup={props.setup}
          onChange={props.onSetupChange}
          onStart={props.onStart}
        />
      </main>
    );
  }
  return <ArenaView {...props} game={game} pageStyle={pageStyle} />;
}

// The arena only exists while a game does; remounts clean every epoch via
// key={epoch} up in LocalSession, so bubbles/flicker/seats never leak.
function ArenaView(
  props: LocalGameProps & {
    readonly game: GameState;
    readonly pageStyle?: { readonly blockSize: string } | undefined;
  },
) {
  const { game, status, presentation, onSubmit, onRematch, onStageReady } = props;
  const t = useT();
  const lang = useLocale();
  const nameOf = (id: PlayerId): string => localNameOf(id, lang);
  const [runtime, setRuntime] = useState<CreatureRuntime | null>(null);
  // LIVE acting seat: a click-selected chip (defaults to the first roster
  // seat). In TURN the acting seat is always the current turn player.
  const [actingId, setActingId] = useState<PlayerId | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const arenaRef = useRef<HTMLDivElement | null>(null);
  const seats = useSeatAnchors(game.roster, runtime, arenaRef);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, []);

  const isLive = game.settings.mode === "live";
  const turnSeat = game.phase === "playing" && !isLive ? game.turnOrder[game.turnIndex] : undefined;
  const acting = isLive ? (actingId ?? game.roster[0]?.id) : turnSeat;
  const actingSlot = game.roster.find((p) => p.id === acting)?.slot;
  // Each seat's assigned goal = the choice on its slot (choice i rides
  // slot i); the dock echoes the acting seat's one.
  const goals = choicesFor(game.roster.length, lang);
  const actingGoal = actingSlot === undefined ? undefined : goals[actingSlot];

  const onReady = (rt: CreatureRuntime): void => {
    setRuntime(rt);
    onStageReady(rt);
  };

  const { stageState, presentation: reacted } = usePostReaction(
    game.posts,
    game.roster,
    presentation,
  );

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
      turnSeconds: game.settings.turnSeconds,
      liveSeconds: game.settings.liveSeconds,
      settleSeconds: game.settings.settleSeconds,
    }),
    [game],
  );

  const canPost = game.phase === "playing" && acting !== undefined;
  const disabledReason =
    game.phase !== "playing"
      ? t("このゲームはおわったよ")
      : status === "pending"
        ? t("こたえをかんがえちゅう…")
        : undefined;

  return (
    <main className={arena.page} style={props.pageStyle} data-testid="local-game">
      {/* Page-level heading for AT — the game's title lives in the chrome,
           not the arena visuals. */}
      <h1 className="sr-only">ゆらぐー！</h1>
      <div className={arena.arena} ref={arenaRef}>
        <div className={arena.stageWrap}>
          <CreatureStage
            visualState={stageState}
            presentation={reacted}
            backgroundAlpha={0}
            onReady={onReady}
            statusHidden={game.phase === "finished"}
          />
        </div>
        <ScenarioStrip>
          {localScenario(lang)}（{localPersona(lang)}）
        </ScenarioStrip>
        <div className={arena.hudWrap}>
          <GameHud state={hud} youId={acting} now={now} nameOf={nameOf} />
        </div>
        <PlayerSeats
          roster={game.roster}
          positions={seats}
          currentId={acting}
          nameOf={nameOf}
          goals={goals}
          onSelect={isLive ? setActingId : undefined}
        />
        <BubbleLayer posts={game.posts} roster={game.roster} seats={seats} />
        <div className={arena.feedWrap}>
          <MessageFeed posts={game.posts} roster={game.roster} nameOf={nameOf} />
        </div>
        {game.phase === "finished" ? <LocalResult game={game} onRematch={onRematch} /> : null}
      </div>
      <InputDock
        canPost={canPost}
        status={status}
        disabledReason={disabledReason}
        seatLabel={
          acting === undefined ? undefined : t("いまの席：{name}", { name: nameOf(acting) })
        }
        goalLabel={actingGoal === undefined ? undefined : `${actingGoal.symbol}${actingGoal.label}`}
        sendColor={actingSlot === undefined ? undefined : slotColor(actingSlot)}
        onSubmit={(text) => {
          if (acting !== undefined) onSubmit(text, acting);
        }}
      />
    </main>
  );
}
