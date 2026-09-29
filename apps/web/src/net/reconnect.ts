// Automatic reconnect + credential rotation for the room client (Task 20).
// Backoff is exponential — 250ms initial, doubling to a 4s cap — with each
// step jittered by a SEEDED PRNG (mulberry32) so tests are deterministic.
// Every retry rotates the reconnect token (POST /reconnect -> POST
// /ticket) before opening the socket. The loop stops permanently on a
// roomClosed event, terminal error frame, 4xx auth response, or stop().
import type { ErrorPayload, ServerEnvelope, SnapshotPayload } from "@yuragoo/protocol";
import { RoomClient } from "./client";
import { issueTicket, type RoomCredentials, RoomAuthError, rotateCredentials } from "./room-http";

export type { RoomCredentials } from "./room-http";
export { issueTicket, RoomAuthError, rotateCredentials } from "./room-http";

export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly seed: number;
}

// Contract values (Task 20): 250ms -> 4s cap. Tests inject smaller caps
// through RoomConnectionOptions.backoff, never through the wire.
export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 250,
  maxMs: 4_000,
  seed: 0x9e3779b9,
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class Backoff {
  private attempt = 0;
  private readonly rand: () => number;

  constructor(private readonly policy: BackoffPolicy = DEFAULT_BACKOFF) {
    this.rand = mulberry32(policy.seed);
  }

  reset(): void {
    this.attempt = 0;
  }

  // Each delay is the capped exponential step times a jitter factor in
  // [0.5, 1.5) — deterministic under a fixed seed.
  next(): number {
    const base = Math.min(this.policy.maxMs, this.policy.initialMs * 2 ** this.attempt);
    this.attempt += 1;
    return Math.round(base * (0.5 + this.rand()));
  }
}

export interface RoomConnectionOptions {
  readonly roomId: string;
  credentials: RoomCredentials;
  // http(s) origin of the worker API; "" means same-origin (production).
  readonly workerOrigin?: string;
  readonly heartbeatMs?: number | undefined;
  readonly backoff?: BackoffPolicy | undefined;
  readonly onSnapshot?: (payload: SnapshotPayload, envelope: ServerEnvelope) => void;
  readonly onEvent?: (envelope: ServerEnvelope) => void;
  readonly onError?: (payload: ErrorPayload) => void;
  readonly onClose?: (code: number, reason: string) => void;
  readonly onResync?: () => void;
  readonly onReconnect?: () => void; // per successful re-admission
}

const TERMINAL_CODES = new Set(["room-closed", "room-expired", "unknown-room"]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RoomConnection {
  private client: RoomClient | null = null;
  private readonly backoff: Backoff;
  private stopped = false;
  private terminal = false;
  private retrying: Promise<void> | null = null;
  private everConnected = false;

  constructor(private readonly options: RoomConnectionOptions) {
    this.backoff = new Backoff(options.backoff ?? DEFAULT_BACKOFF);
  }

  get current(): RoomClient | null {
    return this.client;
  }
  get credentials(): RoomCredentials {
    return this.options.credentials;
  }
  get gameEpoch(): number {
    return this.client?.gameEpoch ?? 0;
  }
  get finished(): boolean {
    return this.terminal || this.stopped;
  }

  // First admission uses the session token the caller already holds.
  async connect(): Promise<void> {
    await this.openSocket(this.options.credentials.sessionToken);
    this.everConnected = true;
  }

  stop(): void {
    this.stopped = true;
    this.client?.close();
  }

  private apiOrigin(): string {
    return this.options.workerOrigin ?? "";
  }

  private wsUrl(ticket: string): string {
    const http = this.apiOrigin() || window.location.origin;
    return `${http.replace(/^http/, "ws")}/api/rooms/${this.options.roomId}/ws?ticket=${encodeURIComponent(ticket)}`;
  }

  private markTerminal(error: ErrorPayload): void {
    if (TERMINAL_CODES.has(error.code)) this.terminal = true;
  }

  private async openSocket(sessionToken: string): Promise<void> {
    const ticket = await issueTicket(this.apiOrigin(), this.options.roomId, sessionToken);
    this.client = new RoomClient({
      roomId: this.options.roomId,
      ticket,
      url: this.wsUrl(ticket),
      heartbeatMs: this.options.heartbeatMs,
      onSnapshot: (p, e) => this.options.onSnapshot?.(p, e),
      onEvent: (e) => {
        if (e.type === "roomClosed") this.terminal = true;
        this.options.onEvent?.(e);
      },
      onError: (p) => {
        this.markTerminal(p);
        this.options.onError?.(p);
      },
      onResync: () => this.options.onResync?.(),
      onClose: (code, reason) => {
        this.options.onClose?.(code, reason);
        if (!this.stopped && !this.terminal) void this.retry();
      },
    });
    await this.client.connect();
  }

  // Single-lane retry loop: every pass rotates the reconnect token, then
  // re-admits. Auth 4xx and terminal frames end it for good.
  private async retry(): Promise<void> {
    if (this.retrying !== null) return this.retrying;
    this.retrying = (async () => {
      for (;;) {
        if (this.stopped || this.terminal) return;
        await sleep(this.backoff.next());
        if (this.stopped || this.terminal) return;
        try {
          const creds = await rotateCredentials(
            this.apiOrigin(),
            this.options.roomId,
            this.options.credentials.reconnectToken,
          );
          this.options.credentials = creds;
          await this.openSocket(creds.sessionToken);
          this.backoff.reset();
          if (this.everConnected) this.options.onReconnect?.();
          return;
        } catch (error) {
          console.log("[ws] reconnect failed", error instanceof Error ? error.message : error);
          if (error instanceof RoomAuthError && error.status >= 400 && error.status < 500) {
            this.terminal = true;
            return;
          }
          // Network/5xx failures retry on the next backoff step.
        }
      }
    })();
    try {
      await this.retrying;
    } finally {
      this.retrying = null;
    }
  }

  send(...args: Parameters<RoomClient["send"]>): ReturnType<RoomClient["send"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.send(...args);
  }

  // Task 24 convenience forwards — same helpers RoomClient exposes, on the
  // socket it currently holds.
  updateLobbyContent(
    payload: Parameters<RoomClient["updateLobbyContent"]>[0],
    expectedLobbyRevision: number,
  ): ReturnType<RoomClient["updateLobbyContent"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.updateLobbyContent(payload, expectedLobbyRevision);
  }

  setReady(ready: boolean): ReturnType<RoomClient["setReady"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.setReady(ready);
  }

  updateLobby(
    settings: Parameters<RoomClient["updateLobby"]>[0],
  ): ReturnType<RoomClient["updateLobby"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.updateLobby(settings);
  }

  generateChoices(): ReturnType<RoomClient["generateChoices"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.generateChoices();
  }

  leaveRoom(): ReturnType<RoomClient["leaveRoom"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.leaveRoom();
  }

  startGame(
    settings?: Parameters<RoomClient["startGame"]>[0],
  ): ReturnType<RoomClient["startGame"]> {
    return this.client === null
      ? Promise.reject(new Error("not connected"))
      : this.client.startGame(settings);
  }
}
