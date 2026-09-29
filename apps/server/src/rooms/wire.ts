// Shared wire helpers for the room's WS protocol (Task 19) and the event
// broadcast path (Task 20): server-envelope construction, snapshot/event
// framing, per-socket delivery, ledger-row -> frame mapping and commandId
// fingerprints. Leaf module — commands.ts, dispatch.ts, transport.ts,
// admit.ts, alarm.ts and presence.ts all build on it.
//
// Outgoing frames are built as plain data and parsed through
// serverEnvelopeSchema once: the parse is the wire-safety boundary and it
// also normalizes the readonly core types into the mutable zod inference.
// Sends are fire-and-forget: a dying socket's send throws inside sendRaw
// and is swallowed there so broadcast to the others still completes.
import type { GameEvent, GameState } from "@yuragoo/game-core";
import {
  type ClientEnvelope,
  type LobbyState,
  protocolVersion,
  serverEnvelopeSchema,
  type ServerEnvelope,
  type WireGameEvent,
} from "@yuragoo/protocol";
import { landedDecisions, landedMoods } from "./ai-jobs";
import type { RoomPlayer } from "./auth-storage";
import type { Books } from "./due";
import { readEnding } from "./ending";
import { roomPlayerView } from "./player-view";
import { type ApplyResult, type EventRow, maxEventSeq } from "./storage";

// Command rejections carry a stable machine-readable code for the error frame.
export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CommandError";
    this.code = code;
  }
}

// The slice of the room needed to stamp envelopes; CommandHost extends it.
export interface WireHost {
  readonly roomId: string;
  roomEpoch(): number;
}

// ---------------------------------------------------------------------------
// Socket attachment + send primitives (moved from transport.ts in Task 20 —
// presence.ts broadcasts without going through the command path).

export interface SocketAttachment {
  readonly playerId: string;
  readonly socketGeneration: number;
}

export const attachmentOf = (ws: WebSocket): SocketAttachment | null => {
  const value: unknown = ws.deserializeAttachment();
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.playerId === "string" && typeof v.socketGeneration === "number"
    ? { playerId: v.playerId, socketGeneration: v.socketGeneration }
    : null;
};

const sendRaw = (ws: WebSocket, json: string): void => {
  try {
    ws.send(json);
  } catch {
    // The socket closed mid-broadcast; delivery to the rest still matters.
  }
};

export const sendTo = (ws: WebSocket, envelope: ServerEnvelope): void => {
  sendRaw(ws, JSON.stringify(envelope));
};

export interface BroadcastHost extends WireHost {
  sockets(): readonly WebSocket[];
}

export const broadcastEnvelope = (host: BroadcastHost, envelope: ServerEnvelope): void => {
  const json = JSON.stringify(envelope);
  for (const ws of host.sockets()) sendRaw(ws, json);
};

// ---------------------------------------------------------------------------

const baseFields = (host: WireHost, eventSeq: number, revision: number) => ({
  protocolVersion,
  eventSeq,
  stateRevision: revision,
  gameId: host.roomId,
  gameEpoch: host.roomEpoch(),
  serverTime: Date.now(),
});

export const frame = (
  host: WireHost,
  eventSeq: number,
  revision: number,
  type: string,
  payload: unknown,
): ServerEnvelope =>
  serverEnvelopeSchema.parse({ ...baseFields(host, eventSeq, revision), type, payload });

export const ackFrame = (host: WireHost, commandId: string, result: ApplyResult): ServerEnvelope =>
  frame(host, result.stateRevision, result.stateRevision, "ack", {
    commandId,
    accepted: true,
    inputSeq: result.ack.inputSeq,
    stateRevision: result.stateRevision,
  });

// GameEvent is JSON-safe; the clone only relabels readonly arrays into the
// mutable shape the wire schema infers — no data changes hands.
const toWireEvent = (event: GameEvent): WireGameEvent =>
  JSON.parse(JSON.stringify(event)) as WireGameEvent;

export const snapshotFrame = (
  host: WireHost & { readonly sql: SqlStorage },
  books: Books | null,
  players: readonly RoomPlayer[],
  hostPlayerId: string | null,
  lobby: LobbyState,
): ServerEnvelope => {
  const nowMs = Date.now();
  // The shared ledger head doubles as the heal point — a stale
  // books.meta value would leave room frames buffered as a permanent gap.
  const seq = maxEventSeq(host.sql);
  return frame(host, seq, seq, "snapshot", {
    state: books === null ? null : JSON.parse(JSON.stringify(books.state)),
    decisions: landedDecisions(host.sql),
    moods: landedMoods(host.sql),
    phase: books?.state.phase ?? "lobby",
    inputSeq: books?.meta.inputSeq ?? 0,
    hostPlayerId,
    players: players.map((p) => roomPlayerView(p, nowMs)),
    lobby,
    ending: books === null ? null : readEnding(host.sql), // panels ride the snapshot
  });
};

// Persisted events -> broadcast frames. Every accepted command's events get
// the post-commit stateRevision; each event keeps its own row seq as
// eventSeq so clients can gap-detect the stream.
export const eventFrames = (
  host: WireHost,
  result: ApplyResult,
  state: GameState,
): ServerEnvelope[] =>
  result.events.map(({ seq, event }) =>
    gameEventFrame(host, seq, result.stateRevision, event, state),
  );

const gameEventFrame = (
  host: WireHost,
  seq: number,
  revision: number,
  event: GameEvent,
  state: GameState,
): ServerEnvelope => {
  const wire = toWireEvent(event);
  if (event.type === "posted") {
    const post = state.posts.find((p) => p.postId === event.postId);
    return frame(host, seq, revision, "inputAccepted", {
      event: wire,
      phase: state.phase,
      ...(post === undefined ? {} : { post }),
    });
  }
  return frame(host, seq, revision, "phaseChanged", { event: wire, phase: state.phase });
};

// events-table types whose payload is already a wire envelope payload
// (room-lifetime frames, Task-22 decisionUpdated rows, Task-32 endings).
const ROOM_FRAME_TYPES = new Set([
  "presenceChanged",
  "hostChanged",
  "roomClosed",
  "decisionUpdated",
  "decisionFailed",
  // Task 24: lobby ledger + membership rows — payloads are already the
  // wire shape (lobbyState / roomPlayerView / {playerId}).
  "lobbyChanged",
  "lobbyReopened",
  "memberJoined",
  "memberLeft",
  // Task 25: the one-shot generation outcome rows — the proposal and
  // the failure ride the same persisted stream as every other room event.
  "choicesGenerated",
  "generationFailed",
  // Task 32: kamishibai panels — fired at finish, then once generated.
  "endingReady",
]);

// One persisted row -> one envelope. Game rows map through the event
// payload into inputAccepted/phaseChanged; room rows frame their stored
// payload directly.
export const eventRowEnvelope = (
  host: WireHost,
  row: EventRow,
  state: GameState | null,
  revision: number,
): ServerEnvelope | null => {
  if (ROOM_FRAME_TYPES.has(row.type)) {
    return frame(host, row.seq, revision, row.type, JSON.parse(row.payload));
  }
  if (state === null) return null;
  return gameEventFrame(host, row.seq, revision, JSON.parse(row.payload) as GameEvent, state);
};

// Replay every ledger row newer than `sinceSeq` to all connected sockets.
// Presence commits, sweeps and alarm-fired transitions all publish through
// this single ordered path so clients see one contiguous event stream.
export const broadcastNewEvents = (
  host: BroadcastHost & { readonly sql: SqlStorage },
  sinceSeq: number,
  state: GameState | null,
): void => {
  const rows = host.sql
    .exec<EventRow>("SELECT seq, type, payload FROM events WHERE seq > ? ORDER BY seq", sinceSeq)
    .toArray();
  if (rows.length === 0) return;
  const revision = maxEventSeq(host.sql);
  for (const row of rows) {
    const envelope = eventRowEnvelope(host, row, state, revision);
    if (envelope !== null) broadcastEnvelope(host, envelope);
  }
};

// ---------------------------------------------------------------------------
// Dedupe fingerprint: canonical JSON of {type, payload} — two payloads are
// "the same" iff their canonical forms match byte for byte.

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

export const fingerprintOf = (env: ClientEnvelope): string =>
  JSON.stringify(sortKeys({ type: env.type, payload: env.payload }));
