// The room page's merged UI state: the snapshot heals, ordered events fold.
import type { PostedInput } from "@yuragoo/game-core";
import {
  type DecisionDistribution,
  type EndingStory,
  LOBBY_SETTINGS_DEFAULT,
  type LobbyState,
  type RoomPlayerView,
  type ServerEnvelope,
  type SnapshotPayload,
} from "@yuragoo/protocol";
import { deadlineFor } from "./room-arena";
import { membershipPatch } from "./view-members";

export type RoomPhase = "lobby" | "playing" | "complete" | "finished";
export type RoomOutcome = NonNullable<SnapshotPayload["state"]>["outcome"];

// Task 25: the in-flight one-shot generation proposal (ephemeral — the
// durable spent flag is lobby.generationSpent). lobbyRevision is the
// request-time capture; applying uses the CURRENT lobby revision.
export interface ChoiceProposal {
  readonly lobbyRevision: number;
  readonly memberCount: number;
  readonly labels: readonly string[];
}

export interface GenerationError {
  readonly code: string;
  readonly message: string;
  readonly slotSpent: boolean;
}

// The wire RoomPlayerView plus the member profile fields the folded view
// keeps for presentation — avatarUrl mirrors the (optional) protocol
// field, so a snapshot/event carrying it lands here untouched.
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
  generationError: null,
  turn: null,
  roster: [],
  posts: [],
  dists: new Map(),
  deadlineAtMs: null,
  clockOffset: 0,
  epoch: 0,
});

// The snapshot is the heal point — every field it carries replaces the
// folded state outright; the feed log survives across resyncs.
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

// A landed decision (or terminal failure) flips the post out of pending.
const markEvaluated = (posts: readonly PostedInput[], postId: string): readonly PostedInput[] =>
  posts.map((p) => (p.postId === postId ? { ...p, status: "evaluated" as const } : p));

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
        deadlineAtMs: null,
      };
    case "memberJoined":
    case "memberLeft":
    case "presenceChanged":
    case "hostChanged":
      return { ...view, feed, clockOffset, epoch, ...membershipPatch(view, env) };
    case "choicesGenerated":
      // The proposal is a suggestion only — landing it in the view never
      // touches the lobby fields; the slot is spent either way.
      return {
        ...view,
        feed,
        clockOffset,
        epoch,
        lobby: { ...view.lobby, generationSpent: true },
        choiceProposal: env.payload,
        generationError: null,
      };
    case "generationFailed":
      return {
        ...view,
        feed,
        clockOffset,
        epoch,
        lobby: env.payload.slotSpent ? { ...view.lobby, generationSpent: true } : view.lobby,
        choiceProposal: null,
        generationError: env.payload,
      };
    case "endingReady":
      // Fires twice per game (template, then generated) — last write wins.
      return { ...view, feed, clockOffset, epoch, ending: env.payload };
    case "decisionUpdated": {
      const { postId, distribution } = env.payload;
      if (postId === undefined || distribution === undefined) {
        return { ...view, feed, clockOffset, epoch };
      }
      const dists = new Map(view.dists).set(postId, distribution);
      return { ...view, feed, clockOffset, epoch, dists, posts: markEvaluated(view.posts, postId) };
    }
    case "decisionFailed":
      // The eval is never coming; no dist lands, so latestRoomDist still
      // skips it — the bubble already shows the text either way.
      return {
        ...view,
        feed,
        clockOffset,
        epoch,
        posts: markEvaluated(view.posts, env.payload.postId),
      };
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
