// Browser room client (Task 19): connects with a single-use ticket, speaks
// the versioned command envelope protocol, tracks the game epoch from
// incoming frames and auto-resyncs (syncRequest -> snapshot) when the
// ordered event stream gaps.
import {
  type ClientCommandType,
  type ClientEnvelope,
  type ErrorPayload,
  type LobbySettings,
  parseServerEnvelope,
  protocolVersion,
  type ServerEnvelope,
  type SnapshotPayload,
} from "@yuragoo/protocol";
import { ingest, initSync, type SyncMachine } from "./sync";
import { wsUrl } from "./urls";

export interface RoomClientOptions {
  readonly roomId: string;
  readonly ticket: string;
  // Full ws(s):// URL override for tests; otherwise derived from location.
  readonly url?: string;
  // Presence heartbeat cadence (Task 20). The production contract is 15s;
  // the server's lease is always >= 3x this so one missed beat never drops
  // presence. Tests may pass a compressed value — the server never reads
  // timing from the payload, the interval only decides when we send.
  readonly heartbeatMs?: number | undefined;
  readonly onSnapshot?: (payload: SnapshotPayload, envelope: ServerEnvelope) => void;
  readonly onEvent?: (envelope: ServerEnvelope) => void;
  readonly onError?: (payload: ErrorPayload) => void;
  readonly onClose?: (code: number, reason: string) => void;
  readonly onResync?: () => void;
}

interface PendingAck {
  readonly resolve: (envelope: ServerEnvelope) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const ACK_TIMEOUT_MS = 10_000;
// Contract heartbeat cadence (Task 20): the 45s lease outlives two missed
// beats. Server-side timing comes from bindings, never this constant.
const HEARTBEAT_MS = 15_000;

const wsUrlFor = (roomId: string, ticket: string): string => {
  return wsUrl(`/api/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`);
};

export class RoomClient {
  private ws: WebSocket | null = null;
  private sync: SyncMachine = initSync();
  private epoch = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, PendingAck>();

  constructor(private readonly options: RoomClientOptions) {}

  get gameEpoch(): number {
    return this.epoch;
  }

  get lastEventSeq(): number {
    return this.sync.lastSeq;
  }

  connect(): Promise<void> {
    const url = this.options.url ?? wsUrlFor(this.options.roomId, this.options.ticket);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        // Presence lease: heartbeat on a fixed cadence while the socket is
        // open; the send is fire-and-forget — a dead socket's failure is
        // surfaced by the close event, not the ack.
        this.heartbeat = setInterval(() => {
          void this.send("heartbeat").catch(() => undefined);
        }, this.options.heartbeatMs ?? HEARTBEAT_MS);
        resolve();
      });
      ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
      ws.addEventListener("error", () => reject(new Error("websocket error")));
      ws.addEventListener("close", (e) => {
        this.stopHeartbeat();
        this.failAll(new Error(`websocket closed (${e.code})`));
        this.options.onClose?.(e.code, e.reason);
      });
    });
  }

  close(): void {
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.failAll(new Error("client closed"));
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  // Every command is one envelope: fresh uuid commandId for dedupe, the
  // room's gameId, and the epoch the client last synced to.
  send(type: ClientCommandType, payload: ClientEnvelope["payload"] = {}): Promise<ServerEnvelope> {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const commandId = crypto.randomUUID();
    const envelope: ClientEnvelope = {
      protocolVersion,
      commandId,
      gameId: this.options.roomId,
      expectedGameEpoch: this.epoch,
      type,
      payload,
    } as ClientEnvelope;
    return new Promise((resolve, reject) => {
      this.pending.set(commandId, {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(commandId);
          reject(new Error(`ack timeout for ${type}`));
        }, ACK_TIMEOUT_MS),
      });
      ws.send(JSON.stringify(envelope));
    });
  }

  submitText(text: string): Promise<ServerEnvelope> {
    return this.send("submitText", { text });
  }

  startGame(settings: LobbySettings = {}): Promise<ServerEnvelope> {
    return this.send("startGame", settings);
  }

  // Task 24 lobby commands. updateLobbyContent carries the revision the
  // edit is based on — the server rejects stale revisions with
  // "lobby-revision-conflict" and the caller keeps its dirty field.
  updateLobbyContent(
    payload: {
      scenario?: string;
      choices?: Array<{ choiceId: string; label: string }>;
    },
    expectedLobbyRevision: number,
  ): Promise<ServerEnvelope> {
    return this.send("updateLobbyContent", { ...payload, expectedLobbyRevision });
  }

  setReady(ready: boolean): Promise<ServerEnvelope> {
    return this.send("setReady", { ready });
  }

  // Task 26: host-only settings patch — the shared view + cleared ready
  // flags arrive as the lobbyChanged broadcast.
  updateLobby(settings: LobbySettings): Promise<ServerEnvelope> {
    return this.send("updateLobby", settings);
  }

  // Task 25: host-only one-shot AI choice generation. The ack only means
  // the request was accepted — the proposal/failure arrives later as
  // choicesGenerated / generationFailed ordered events.
  generateChoices(): Promise<ServerEnvelope> {
    return this.send("generateChoices", {});
  }

  leaveRoom(): Promise<ServerEnvelope> {
    return this.send("leave", {});
  }

  closeRoom(): Promise<ServerEnvelope> {
    return this.send("closeRoom", {});
  }

  requestSync(): Promise<ServerEnvelope> {
    // syncRequest bypasses the epoch check server-side by design.
    return this.send("syncRequest", { lastEventSeq: this.sync.lastSeq });
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Non-JSON from the server is a protocol bug; drop it.
    }
    const envelope = parseServerEnvelope(parsed);
    if (envelope === null) return;
    // Every frame carries the room epoch — track it so subsequent commands
    // always declare the generation the client actually sees.
    this.epoch = envelope.gameEpoch;
    const result = ingest(this.sync, envelope);
    this.sync = result.machine;
    switch (result.ingest.kind) {
      case "snapshot":
        if (envelope.type === "snapshot") {
          this.options.onSnapshot?.(envelope.payload, envelope);
        }
        for (const event of result.ingest.replay) this.options.onEvent?.(event);
        break;
      case "ordered":
        for (const event of result.ingest.events) this.options.onEvent?.(event);
        break;
      case "gap":
        this.options.onResync?.();
        void this.requestSync().catch(() => undefined);
        break;
      case "duplicate":
        break;
      case "control":
        if (envelope.type === "ack") {
          const commandId = envelope.payload.commandId;
          const pending = this.pending.get(commandId);
          if (pending !== undefined) {
            this.pending.delete(commandId);
            clearTimeout(pending.timer);
            pending.resolve(envelope);
          }
        } else if (envelope.type === "error") {
          const payload = envelope.payload;
          console.log("[ws] error", payload.code, payload.message);
          const pending =
            payload.commandId === undefined ? undefined : this.pending.get(payload.commandId);
          if (pending !== undefined && payload.commandId !== undefined) {
            this.pending.delete(payload.commandId);
            clearTimeout(pending.timer);
            pending.reject(new Error(`${payload.code}: ${payload.message}`));
          } else {
            this.options.onError?.(payload);
          }
        }
        break;
    }
  }
}
