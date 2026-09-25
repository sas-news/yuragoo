// E2E-only room bridge (Task 20): window.__roomBridge is mounted by
// main.tsx ONLY when import.meta.env.MODE === "e2e", so the production
// bundle never carries it. It wraps the room-auth HTTP routes, RoomClient
// and RoomConnection with a per-client frame/event log the specs poll via
// waitForFunction — every field is plain JSON, no classes cross the page
// boundary.
import type { ServerEnvelope, SnapshotPayload } from "@yuragoo/protocol";
import { RoomClient } from "./client";
import {
  type BackoffPolicy,
  type RoomCredentials,
  RoomConnection,
  issueTicket,
  rotateCredentials,
} from "./reconnect";

export interface BridgeClientView {
  readonly frames: ServerEnvelope[];
  readonly events: ServerEnvelope[];
  snapshot: SnapshotPayload | null;
  closed: { readonly code: number; readonly reason: string } | null;
  reconnects: number;
  client: RoomClient | null;
  conn: RoomConnection | null;
}

export interface JoinedAuth {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
  readonly lobbyWaiting: boolean;
}

const post = async (origin: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    let code = `http-${res.status}`;
    try {
      const b: unknown = await res.json();
      if (b !== null && typeof b === "object" && "error" in b) {
        code = String((b as { error: unknown }).error);
      }
    } catch {
      // Keep the status-derived code.
    }
    throw new Error(code);
  }
  return (await res.json()) as T;
};

const newView = (): BridgeClientView => ({
  frames: [],
  events: [],
  snapshot: null,
  closed: null,
  reconnects: 0,
  client: null,
  conn: null,
});

const wireCallbacks = (view: BridgeClientView) => ({
  onSnapshot: (p: SnapshotPayload, e: ServerEnvelope) => {
    view.snapshot = p;
    view.frames.push(e);
  },
  onEvent: (e: ServerEnvelope) => {
    view.frames.push(e);
    view.events.push(e);
  },
  onClose: (code: number, reason: string) => {
    view.closed = { code, reason };
  },
  onReconnect: () => {
    view.reconnects += 1;
  },
});

export interface RoomBridge {
  readonly clients: Record<string, BridgeClientView>;
  createRoom(origin: string): Promise<{ roomId: string; inviteSecret: string }>;
  join(
    origin: string,
    roomId: string,
    inviteSecret: string,
    displayName?: string,
  ): Promise<JoinedAuth>;
  rotate(origin: string, roomId: string, reconnectToken: string): Promise<RoomCredentials>;
  connect(
    id: string,
    opts: { origin: string; roomId: string; sessionToken: string; heartbeatMs?: number },
  ): Promise<void>;
  connectAuto(
    id: string,
    opts: {
      origin: string;
      roomId: string;
      credentials: RoomCredentials;
      heartbeatMs?: number;
      backoff?: BackoffPolicy;
    },
  ): Promise<void>;
  send(id: string, type: string, payload?: unknown): Promise<unknown>;
  close(id: string): void;
}

export const mountRoomBridge = (): RoomBridge => {
  const bridge: RoomBridge = {
    clients: {},
    createRoom: async (origin) => json(await post(origin, "/api/rooms", {})),
    join: async (origin, roomId, inviteSecret, displayName) =>
      json(
        await post(origin, `/api/rooms/${roomId}/join`, {
          inviteSecret,
          ...(displayName === undefined ? {} : { displayName }),
        }),
      ),
    rotate: (origin, roomId, reconnectToken) => rotateCredentials(origin, roomId, reconnectToken),
    connect: async (id, opts) => {
      const view = newView();
      bridge.clients[id] = view;
      const ticket = await issueTicket(opts.origin, opts.roomId, opts.sessionToken);
      const http = opts.origin || window.location.origin;
      const ws = `${http.replace(/^http/, "ws")}/api/rooms/${opts.roomId}/ws?ticket=${encodeURIComponent(ticket)}`;
      const client = new RoomClient({
        roomId: opts.roomId,
        ticket,
        url: ws,
        heartbeatMs: opts.heartbeatMs,
        ...wireCallbacks(view),
      });
      view.client = client;
      await client.connect();
    },
    connectAuto: async (id, opts) => {
      const view = newView();
      bridge.clients[id] = view;
      const conn = new RoomConnection({
        roomId: opts.roomId,
        credentials: opts.credentials,
        workerOrigin: opts.origin,
        heartbeatMs: opts.heartbeatMs,
        ...(opts.backoff === undefined ? {} : { backoff: opts.backoff }),
        ...wireCallbacks(view),
      });
      view.conn = conn;
      await conn.connect();
    },
    send: (id, type, payload) => {
      const view = bridge.clients[id];
      const target = view?.conn ?? view?.client;
      if (target === null || target === undefined) return Promise.reject(new Error("no client"));
      return target.send(type as never, payload as never);
    },
    close: (id) => {
      const view = bridge.clients[id];
      view?.conn?.stop();
      view?.client?.close();
    },
  };
  (window as unknown as { __roomBridge?: RoomBridge }).__roomBridge = bridge;
  return bridge;
};
