// The room page's merged UI state: the snapshot heals, ordered events fold.
import type { PostedInput } from "@yuragoo/game-core";
import {
  type DecisionDistribution,
  type EndingStory,
  LOBBY_SETTINGS_DEFAULT,
  type LobbyState,
  type MoodId,
  type RoomPlayerView,
  type ServerEnvelope,
  type SnapshotPayload,
} from "@yuragoo/protocol";
import { deadlineFor } from "./room-arena";
import { decisionPatch } from "./view-decisions";
import { membershipPatch } from "./view-members";
import { proposalPatch } from "./view-proposals";

export type RoomPhase = "lobby" | "playing" | "complete" | "finished";
export type RoomOutcome = NonNullable<SnapshotPayload["state"]>["outcome"];

// Task 25: the ephemeral generation proposal; apply uses the CURRENT revision.
export interface ChoiceProposal {
  readonly lobbyRevision: number;
  readonly memberCount: number;
  readonly labels: readonly string[];
}

// Task 44: the scenario-generation proposal — same apply contract, own slot.
export interface ScenarioProposal {
  readonly lobbyRevision: number;
  readonly scenario: string;
}

export interface GenerationError {
  readonly code: string;
  readonly message: string;
  readonly slotSpent: boolean;
}

// Wire player view + presentation extras (avatarUrl rides the wire field).
export type RoomPlayer = RoomPlayerView & { readonly avatarUrl?: string | undefined };

export interface RoomView {
  readonly phase: RoomPhase;
  readonly state: SnapshotPayload["state"];
  readonly players: readonly RoomPlayer[];
  readonly hostPlayerId: string | null;
  readonly lobby: LobbyState;
  // Last N ordered frames, newest last — the playing screen's event feed.
  readonly feed: readonly ServerEnvelope[];
  readonly outcome: RoomOutcome;
  // Task 32: the kamishibai panel set — null until the room writes it; a
  // template-only finish reports `generated:false` until generation lands.
  readonly ending: EndingStory | null;
  readonly choiceProposal: ChoiceProposal | null;
  readonly scenarioProposal: ScenarioProposal | null;
  readonly generationError: GenerationError | null;
  // Task 28: the live turn pointer and the game roster, folded from the
  // snapshot + ordered events so the input dock never needs the raw
  // GameState (which a lobby-connected client's snapshot never carried).
  readonly turn: { readonly playerId: string; readonly round: number } | null;
  readonly roster: readonly { readonly id: string; readonly slot: number }[];
  // The in-game arena's working set, folded from the same frames: the
  // post list drives seats/bubbles/feed, the decision map drives the
  // creature's pull, and deadlineAtMs (server clock) drives the HUD bar.
  readonly posts: readonly PostedInput[];
  readonly dists: ReadonlyMap<string, readonly DecisionDistribution[]>;
  // Jev's mood pick per postId (Task 43) — parallel to dists; a verdict
  // without a mood simply has no entry and the face falls back to the
  // distribution-shape heuristic.
  readonly moods: ReadonlyMap<string, MoodId>;
  readonly deadlineAtMs: number | null;
  // Latest frame's (serverTime - client clock) — the HUD renders `now`
  // on the server clock so the deadline bar can't skew.
  readonly clockOffset: number;
  // The game epoch riding every frame — RoomPage keys RoomGame on it so a
  // rematch remounts the arena (post ids restart at p1; the post-reaction
  // flicker's seen-set must not carry over).
  readonly epoch: number;
}

const EMPTY_LOBBY: LobbyState = {
  revision: 0,
  scenario: "",
  choices: [],
  ready: [],
  committedCount: 0,
  generationSpent: false,
  scenarioSpent: false,
  settings: LOBBY_SETTINGS_DEFAULT,
};

export const initialView = (): RoomView => ({
  phase: "lobby",
  state: null,
  players: [],
  hostPlayerId: null,
  lobby: EMPTY_LOBBY,
  feed: [],
  outcome: null,
  ending: null,
  choiceProposal: null,
  scenarioProposal: null,
  generationError: null,
  turn: null,
  roster: [],
  posts: [],
  dists: new Map(),
  moods: new Map(),
  deadlineAtMs: null,
  clockOffset: 0,
  epoch: 0,
});

// The snapshot is the heal point: it replaces the fold outright.
export const applySnapshot = (
  view: RoomView,
  p: SnapshotPayload,
  serverTimeMs?: number,
  gameEpoch?: number,
): RoomView => {
  const s = p.state;
  return {
    ...view,
    phase: p.phase,
    state: s === null ? null : (s as RoomView["state"]),
    players: p.players,
    hostPlayerId: p.hostPlayerId,
    lobby: p.lobby,
    outcome: s?.outcome ?? null,
    roster: s?.roster ?? [],
    posts: s?.posts ?? [],
    dists: new Map(Object.entries(p.decisions ?? {})),
    moods: new Map(Object.entries(p.moods ?? {})),
    // Ordered frames older than the healed revision never replay, so the
    // snapshot is the only path a reconnecting client sees the panels.
    ending: p.ending ?? null,
    deadlineAtMs: s?.deadlineAtMs ?? null,
    clockOffset: serverTimeMs === undefined ? view.clockOffset : serverTimeMs - Date.now(),
    epoch: gameEpoch ?? view.epoch,
    turn:
      s !== null && s.phase === "playing" && s.settings.mode === "turn"
        ? { playerId: s.turnOrder[s.turnIndex] ?? "", round: s.round }
        : null,
  };
};

const push = (view: RoomView, env: ServerEnvelope): readonly ServerEnvelope[] =>
  [...view.feed, env].slice(-60);

export const applyEvent = (view: RoomView, env: ServerEnvelope): RoomView => {
  const feed = push(view, env);
  const clockOffset = env.serverTime - Date.now();
  const epoch = env.gameEpoch;
  switch (env.type) {
    case "lobbyChanged":
      // Content edits land per keystroke — they update the shared lobby
      // state but must NOT enter the feed (a line per keystroke floods it).
      return { ...view, lobby: env.payload, clockOffset, epoch };
    case "lobbyReopened":
      // backToLobby: the game is gone — fold back to a clean lobby view
      // while keeping the feed (the transition line lands on it).
      return {
        ...view,
        feed,
        clockOffset,
        epoch,
        phase: "lobby",
        state: null,
        lobby: env.payload,
        outcome: null,
        ending: null,
        turn: null,
        posts: [],
        dists: new Map(),
        moods: new Map(),
        deadlineAtMs: null,
      };
    case "memberJoined":
    case "memberLeft":
    case "presenceChanged":
    case "hostChanged":
      return { ...view, feed, clockOffset, epoch, ...membershipPatch(view, env) };
    case "choicesGenerated":
    case "scenarioGenerated":
    case "generationFailed":
      // Proposal/failure folds live in view-proposals.ts (LOC split).
      return { ...view, feed, clockOffset, epoch, ...proposalPatch(view, env) };
    case "endingReady":
      // Fires twice per game (template, then generated) — last write wins.
      return { ...view, feed, clockOffset, epoch, ending: env.payload };
    case "decisionUpdated":
    case "decisionFailed":
      // Verdict + mood fold lives in view-decisions.ts (LOC split).
      return { ...view, feed, clockOffset, epoch, ...decisionPatch(view, env) };
    case "phaseChanged":
    case "inputAccepted": {
      const e = env.payload.event;
      // A new epoch ("started" — first game or rematch) resets the post
      // list and the pull memory; an accepted post appends itself.
      const posts =
        e.type === "started"
          ? []
          : env.type === "inputAccepted" && env.payload.post !== undefined
            ? [...view.posts, env.payload.post]
            : view.posts;
      return {
        ...view,
        feed,
        clockOffset,
        epoch,
        phase: env.payload.phase,
        outcome: e.type === "finished" ? e.outcome : e.type === "started" ? null : view.outcome,
        ending: e.type === "started" ? null : view.ending,
        deadlineAtMs: deadlineFor(view, env),
        posts,
        dists: e.type === "started" ? new Map() : view.dists,
        moods: e.type === "started" ? new Map() : view.moods,
        // "started" carries the fresh roster (a rematch lands here — it
        // create+starts the next epoch in one commit); "turn" moves the
        // pointer; complete/finished clear it. Other events keep both.
        roster: e.type === "started" ? e.roster : view.roster,
        turn:
          e.type === "turn"
            ? { playerId: e.playerId, round: e.round }
            : e.type === "complete" || e.type === "finished" || e.type === "started"
              ? null
              : view.turn,
      };
    }
    default:
      return { ...view, feed, clockOffset, epoch };
  }
};
