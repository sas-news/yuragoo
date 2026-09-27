// The reducer: (state, action) -> { state, commands }. Pure and total —
// every rejection throws a GameRuleError before any new state is built, so
// a rejected action neither mutates nor emits. Side effects are only ever
// returned as commands for the host runtime to execute.
import { validatePostText } from "@yuragoo/protocol";
import type { GameAction, GameCommand, GameTransition } from "./commands";
import { adhere, dwellComplete, requestEnd } from "./early-decision";
import { acceptLivePost } from "./live";
import { enterComplete, settle, settleDeadline } from "./settlement";
import { validateSettings } from "./settings";
import {
  GameRuleError,
  isPlayerId,
  type GameOutcome,
  type GameState,
  type Player,
  type PostedInput,
} from "./state";
import { acceptTurnPost, currentTurnPlayer, orderForRound, passAction, passTurn } from "./turn";

const checkNowMs = (nowMs: number): void => {
  if (!Number.isFinite(nowMs)) {
    throw new GameRuleError("bad-state", "nowMs must be a finite number");
  }
};

const requireState = (state: GameState | null): GameState => {
  if (state === null) {
    throw new GameRuleError("bad-state", "action requires an existing game");
  }
  return state;
};

type CreateAction = Extract<GameAction, { type: "create" }>;
type PostAction = Extract<GameAction, { type: "post" }>;

// create: validate settings + roster, seat ids in JOIN order. The lobby's
// choice rows already show row i = member i, so the in-game slot must be
// the same index — a seeded shuffle here silently re-assigned every
// player's choice (ロビー表示と ABCD がずれる bug). The game is born in the
// lobby phase and emits nothing — `started` belongs to the start action.
const createGame = (state: GameState | null, action: CreateAction): GameTransition => {
  if (state !== null) {
    throw new GameRuleError("bad-state", "game already exists");
  }
  checkNowMs(action.nowMs);
  const ids = action.playerIds;
  const settings = validateSettings(action.settings, ids);
  if (ids.length !== settings.rosterSize) {
    throw new GameRuleError("bad-state", "playerIds length must equal settings.rosterSize");
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isPlayerId(id)) {
      throw new GameRuleError("bad-state", `invalid player id: ${id}`);
    }
    if (seen.has(id)) {
      throw new GameRuleError("bad-state", `duplicate player id: ${id}`);
    }
    seen.add(id);
  }
  const roster: Player[] = ids.map((id, slot) => ({ id, slot }));
  const game: GameState = {
    settings,
    phase: "lobby",
    roster,
    turnOrder: orderForRound(roster, 0, settings.hostId),
    round: 0,
    turnIndex: 0,
    deadlineAtMs: action.nowMs,
    posts: [],
    seq: 0,
    startedAtMs: action.nowMs,
    outcome: null,
    turnPosterId: null,
    adhesion: null,
    settleCutoffSeq: null,
    settleDeadlineAtMs: null,
    endCause: null,
  };
  return { state: game, commands: [] };
};

const startGame = (state: GameState, nowMs: number): GameTransition => {
  checkNowMs(nowMs);
  if (state.phase !== "lobby") {
    throw new GameRuleError("bad-state", "start requires the lobby phase");
  }
  const isTurn = state.settings.mode === "turn";
  const seconds = isTurn ? state.settings.turnSeconds : state.settings.liveSeconds;
  const deadlineAtMs = nowMs + seconds * 1000;
  const next: GameState = { ...state, phase: "playing", startedAtMs: nowMs, deadlineAtMs };
  const commands: GameCommand[] = [
    { type: "set-deadline", atMs: deadlineAtMs, tag: isTurn ? "turn" : "match" },
    { type: "publish", event: { type: "started", roster: state.roster } },
  ];
  if (isTurn) {
    commands.push({
      type: "publish",
      event: { type: "turn", round: 0, playerId: currentTurnPlayer(next) },
    });
  }
  return { state: next, commands };
};

// post: all rejection checks run before any state is built, so a rejected
// post leaves the input state bit-identical and emits no commands.
const postInput = (state: GameState, action: PostAction): GameTransition => {
  checkNowMs(action.nowMs);
  if (state.phase !== "playing") {
    throw new GameRuleError("not-playing", "posts require the playing phase");
  }
  if (action.nowMs >= state.deadlineAtMs) {
    throw new GameRuleError("too-late", "post arrived at or after the deadline");
  }
  if (!state.roster.some((p) => p.id === action.playerId)) {
    throw new GameRuleError("unknown-player", "playerId is not in the roster");
  }
  // Text bounds come from the shared protocol validator (140 graphemes) so
  // the core and the input dock can never disagree about what fits.
  const textCheck = validatePostText(action.text);
  if (!textCheck.ok) {
    throw new GameRuleError(
      textCheck.reason === "empty" ? "empty-text" : "too-long",
      textCheck.reason === "empty" ? "post text must be non-blank" : "post text is too long",
    );
  }
  return state.settings.mode === "turn"
    ? acceptTurnPost(state, action.playerId, action.text, action.nowMs)
    : acceptLivePost(state, action.playerId, action.text, action.nowMs);
};

const deadlineReached = (state: GameState, nowMs: number): GameTransition => {
  checkNowMs(nowMs);
  if (state.phase !== "playing") {
    throw new GameRuleError("bad-state", "deadline-reached requires the playing phase");
  }
  if (nowMs < state.deadlineAtMs) {
    throw new GameRuleError("bad-state", "deadline has not been reached yet");
  }
  if (state.settings.mode === "live") {
    // Match clock expired: gameplay closes into the settle window.
    return enterComplete(state, nowMs, "deadline");
  }
  return passTurn(state, currentTurnPlayer(state), nowMs);
};

const markEvaluated = (state: GameState, postId: string): GameTransition => {
  const index = state.posts.findIndex((p) => p.postId === postId);
  const post = state.posts[index];
  if (index < 0 || post === undefined) {
    throw new GameRuleError("bad-state", `unknown postId: ${postId}`);
  }
  if (post.status !== "pending") {
    throw new GameRuleError("bad-state", `post ${postId} is already evaluated`);
  }
  const updated: PostedInput = { ...post, status: "evaluated" };
  const posts = state.posts.map((p, i) => (i === index ? updated : p));
  return { state: { ...state, posts }, commands: [] };
};

const abortGame = (state: GameState): GameTransition => {
  // An outcome is decided exactly once: abort is still allowed from
  // lobby/playing/complete, but a finished game is immutable.
  if (state.phase === "finished") {
    throw new GameRuleError("bad-state", "abort requires a game that is not finished");
  }
  const outcome: GameOutcome = { kind: "noContest", reason: "aborted" };
  return {
    state: { ...state, phase: "finished", outcome },
    commands: [
      { type: "finish", outcome },
      { type: "publish", event: { type: "finished", outcome } },
    ],
  };
};

const exhaust = (action: never): never => {
  throw new GameRuleError("bad-state", `unknown action: ${JSON.stringify(action)}`);
};

export const reduce = (state: GameState | null, action: GameAction): GameTransition => {
  switch (action.type) {
    case "create":
      return createGame(state, action);
    case "start":
      return startGame(requireState(state), action.nowMs);
    case "post":
      return postInput(requireState(state), action);
    case "deadline-reached":
      return deadlineReached(requireState(state), action.nowMs);
    case "pass":
      return passAction(requireState(state), action.playerId, action.nowMs);
    case "evaluated":
      return markEvaluated(requireState(state), action.postId);
    case "abort":
      return abortGame(requireState(state));
    case "adhere":
      return adhere(requireState(state), action.slot, action.nowMs);
    case "dwell-complete":
      return dwellComplete(requireState(state), action.nowMs);
    case "request-end":
      return requestEnd(requireState(state), action.playerId, action.nowMs);
    case "settle":
      return settle(requireState(state), action.nowMs, action.claim);
    case "settle-deadline":
      return settleDeadline(requireState(state), action.nowMs);
    default:
      return exhaust(action);
  }
};
