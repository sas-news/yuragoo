// Host-chosen game settings. validateSettings is the single gate: it applies
// the documented defaults, enforces roster/mode caps and returns a frozen,
// fully-resolved object that GameState carries immutably for the whole
// match — no action can ever change settings mid-game.
import { GameRuleError, type PlayerId } from "./state";

export type GameMode = "turn" | "live";

export interface GameSettings {
  readonly mode: GameMode;
  readonly seed: number; // safe int, drives the initial roster shuffle
  readonly rosterSize: number; // set by the host from joined players
  readonly devMode?: boolean; // sandbox: rosterSize 1 + free-range timing knobs
  readonly turnSeconds?: number; // TURN slot length: 10|20|30|45|60, default 20
  readonly rounds?: number; // TURN rounds 1..8, default 3
  readonly liveSeconds?: number; // LIVE match length: 60|120|180|300|600, default 120
  readonly maxPendingPerPlayer?: number; // LIVE pending posts/player, default 1
  readonly adhesionSeconds?: number; // early-decision dwell hold, default 3
  readonly settleSeconds?: number; // settlement window, default 8
  readonly hostId?: string; // early-end authority; default playerIds[0] at create
  // Task 26: optional pre-game switches. Both default OFF — the lobby shows
  // them to every member before start, and the reducer rejects the matching
  // early-end actions outright while a flag is off.
  readonly earlyDecision?: boolean;
  readonly hostDecision?: boolean;
}

// validateSettings' return type: every optional knob resolved to a concrete
// value, so the rules never re-apply defaults mid-game.
export interface ResolvedGameSettings extends GameSettings {
  readonly devMode: boolean;
  readonly turnSeconds: number;
  readonly rounds: number;
  readonly liveSeconds: number;
  readonly maxPendingPerPlayer: number;
  readonly adhesionSeconds: number;
  readonly settleSeconds: number;
  readonly hostId: PlayerId;
  readonly earlyDecision: boolean;
  readonly hostDecision: boolean;
}

export const ROSTER_SIZE_MAX = 6;
// Task 26 contract: multiplayer slot/match lengths are fixed menus, never
// free numbers. The *_MAX constants below stay as the dev-mode (sandbox)
// ceilings — ?turn=/live=/rounds= tuning and the dev harness rely on them;
// production rooms never set devMode so the discrete contract applies.
export const TURN_SECONDS_DEFAULT = 20;
export const TURN_SECONDS_CHOICES = [10, 20, 30, 45, 60] as const;
export const TURN_SECONDS_MAX = 300;
export const ROUNDS_DEFAULT = 3;
export const ROUNDS_CONTRACT_MAX = 8;
export const ROUNDS_MAX = 12;
export const LIVE_SECONDS_DEFAULT = 120;
export const LIVE_SECONDS_CHOICES = [60, 120, 180, 300, 600] as const;
export const LIVE_SECONDS_MAX = 1800;
export const MAX_PENDING_DEFAULT = 1;
export const MAX_PENDING_MAX = 4;
export const ADHESION_SECONDS_DEFAULT = 3;
export const ADHESION_SECONDS_MAX = 60;
export const SETTLE_SECONDS_DEFAULT = 8;
export const SETTLE_SECONDS_MAX = 30;

const bounded = (
  value: number | undefined,
  name: string,
  fallback: number,
  max: number,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new GameRuleError("bad-state", `${name} must be a safe integer in 1..${max}`);
  }
  return resolved;
};

// The contract's discrete menus: anything outside the listed values is
// rejected outright, not clamped into range.
const discrete = (
  value: number | undefined,
  name: string,
  fallback: number,
  choices: readonly number[],
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || !choices.includes(resolved)) {
    throw new GameRuleError("bad-state", `${name} must be one of ${choices.join("/")}`);
  }
  return resolved;
};

// hostId needs the joined ids: it must name a roster member and defaults to
// playerIds[0] — the room creator, pre-shuffle. Callers without a roster
// context (none today) resolve it to "" so request-end can never pass.
const resolveHostId = (
  hostId: string | undefined,
  playerIds: readonly string[] | undefined,
): PlayerId => {
  if (hostId === undefined) {
    return playerIds?.[0] ?? "";
  }
  if (playerIds !== undefined && playerIds.length > 0 && !playerIds.includes(hostId)) {
    throw new GameRuleError("bad-state", "hostId must be one of playerIds");
  }
  return hostId;
};

export const validateSettings = (
  settings: GameSettings,
  playerIds?: readonly string[],
): ResolvedGameSettings => {
  if (settings.mode !== "turn" && settings.mode !== "live") {
    throw new GameRuleError("bad-state", "mode must be 'turn' or 'live'");
  }
  if (!Number.isSafeInteger(settings.seed)) {
    throw new GameRuleError("bad-state", "seed must be a safe integer");
  }
  if (!Number.isSafeInteger(settings.rosterSize)) {
    throw new GameRuleError("bad-state", "rosterSize must be a safe integer");
  }
  const devMode = settings.devMode === true;
  if (settings.rosterSize === 1) {
    // A solo sandbox exists for development only (S:1011-1017).
    if (!devMode) {
      throw new GameRuleError("bad-state", "rosterSize 1 is only allowed with devMode");
    }
  } else if (settings.rosterSize < 2 || settings.rosterSize > ROSTER_SIZE_MAX) {
    // 7+ players is a future team/spectator feature — always reject (S:1019).
    throw new GameRuleError("bad-state", `rosterSize must be 2..${ROSTER_SIZE_MAX}`);
  }
  // All knobs are validated regardless of mode so a typo can never hide in
  // an unused field; unused values just carry their defaults. devMode keeps
  // the wide sandbox ranges (local /play tuning); production rooms get the
  // strict contract menus.
  return Object.freeze({
    mode: settings.mode,
    seed: settings.seed,
    rosterSize: settings.rosterSize,
    devMode,
    turnSeconds: devMode
      ? bounded(settings.turnSeconds, "turnSeconds", TURN_SECONDS_DEFAULT, TURN_SECONDS_MAX)
      : discrete(settings.turnSeconds, "turnSeconds", TURN_SECONDS_DEFAULT, TURN_SECONDS_CHOICES),
    rounds: bounded(
      settings.rounds,
      "rounds",
      ROUNDS_DEFAULT,
      devMode ? ROUNDS_MAX : ROUNDS_CONTRACT_MAX,
    ),
    liveSeconds: devMode
      ? bounded(settings.liveSeconds, "liveSeconds", LIVE_SECONDS_DEFAULT, LIVE_SECONDS_MAX)
      : discrete(settings.liveSeconds, "liveSeconds", LIVE_SECONDS_DEFAULT, LIVE_SECONDS_CHOICES),
    maxPendingPerPlayer: bounded(
      settings.maxPendingPerPlayer,
      "maxPendingPerPlayer",
      MAX_PENDING_DEFAULT,
      MAX_PENDING_MAX,
    ),
    adhesionSeconds: bounded(
      settings.adhesionSeconds,
      "adhesionSeconds",
      ADHESION_SECONDS_DEFAULT,
      ADHESION_SECONDS_MAX,
    ),
    settleSeconds: bounded(
      settings.settleSeconds,
      "settleSeconds",
      SETTLE_SECONDS_DEFAULT,
      SETTLE_SECONDS_MAX,
    ),
    hostId: resolveHostId(settings.hostId, playerIds),
    earlyDecision: settings.earlyDecision === true,
    hostDecision: settings.hostDecision === true,
  });
};
