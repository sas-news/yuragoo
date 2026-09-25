// The slice of GameState the HUD reads — split from GameHud.tsx so pure
// .ts adapters (room-arena, roomHud) can name the type without pulling a
// .tsx module into non-jsx compilations (the node tsconfig covers tests).
// `windowMs` is the full length of the current deadline window (turn slot
// or match length) so the draining bar can scale.
import type { GameMode, GameOutcome, GamePhase, Player, PlayerId } from "@yuragoo/game-core";

export interface HudSnapshot {
  readonly phase: GamePhase;
  readonly mode: GameMode;
  readonly round: number; // 0-based
  readonly rounds: number;
  readonly turnOrder: readonly PlayerId[];
  readonly turnIndex: number;
  readonly roster: readonly Player[];
  readonly deadlineAtMs: number;
  readonly outcome: GameOutcome | null;
  readonly windowMs: number;
  readonly turnSeconds?: number | undefined;
  readonly liveSeconds?: number | undefined;
  readonly settleSeconds?: number | undefined;
}
