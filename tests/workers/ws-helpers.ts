// Shared WebSocket client plumbing for the room-websocket tests. Sockets
// are REAL WebSocketPair clients: SELF.fetch upgrades through the Worker
// into the DO, and response.webSocket is the client end of the pair the DO
// parked via ctx.acceptWebSocket.
import { env, SELF } from "cloudflare:test";
import type { ClientEnvelope, ServerEnvelope } from "@yuragoo/protocol";
import { execSql } from "./room-helpers";

export const BASE = "https://ws.test";
export const GOOD_ORIGIN = "http://localhost:5173";

const post = (path: string, body: unknown): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: JSON.stringify(body),
  });

export interface Created {
  roomId: string;
  inviteSecret: string;
}
export interface Joined {
  playerId: string;
  sessionToken: string;
  reconnectToken: string;
  lobbyWaiting: boolean;
}

export const createRoom = async (): Promise<Created> => {
  const res = await post("/api/rooms", {});
  if (res.status !== 200) throw new Error(`create room failed: ${res.status}`);
  return (await res.json()) as Created;
};

export const joinRoom = async (room: Created): Promise<Joined> => {
  const res = await post(`/api/rooms/${room.roomId}/join`, { inviteSecret: room.inviteSecret });
  if (res.status !== 200) throw new Error(`join failed: ${res.status}`);
  return (await res.json()) as Joined;
};

export const setupRoom = async (players: number): Promise<{ room: Created; joins: Joined[] }> => {
  const room = await createRoom();
  const joins: Joined[] = [];
  for (let i = 0; i < players; i += 1) joins.push(await joinRoom(room));
  return { room, joins };
};

// Task 24: before any startGame send, the host fills scenario + every grown
// choice label at the CURRENT revision and every member readies up.
export const latestLobby = (s: Sock) => {
  for (let i = s.log.length - 1; i >= 0; i -= 1) {
    const e = s.log[i];
    if (e?.type === "lobbyChanged" || e?.type === "lobbyReopened") return e.payload;
    if (e?.type === "snapshot") return e.payload.lobby;
  }
  return null;
};

const ackOrError = (commandId: string) => (e: ServerEnvelope) =>
  (e.type === "ack" && e.payload.commandId === commandId) ||
  (e.type === "error" && e.payload.commandId === commandId);

export const armLobby = async (
  room: Created,
  members: readonly Sock[],
  settings?: Record<string, unknown>,
  ns = "arm",
): Promise<void> => {
  const host = members[0];
  if (host === undefined) throw new Error("armLobby needs at least one socket");
  const lobby = latestLobby(host);
  if (lobby === null) throw new Error("armLobby: host has no lobby state yet");
  host.sendCmd(room.roomId, `${ns}-edit`, "updateLobbyContent", {
    scenario: "夜のおやつ会議",
    choices: lobby.choices.map((c, i) => ({ choiceId: c.choiceId, label: `選択肢${i + 1}` })),
    expectedLobbyRevision: lobby.revision,
  });
  const edit = await host.next(ackOrError(`${ns}-edit`));
  if (edit.type === "error") {
    throw new Error(`armLobby edit rejected: ${edit.payload.code}`);
  }
  // Task 26: settings ride the host-only updateLobby patch so the shared
  // view and the create settings agree; startGame may only confirm them.
  if (settings !== undefined && Object.keys(settings).length > 0) {
    host.sendCmd(room.roomId, `${ns}-settings`, "updateLobby", settings);
    const res = await host.next(ackOrError(`${ns}-settings`));
    if (res.type === "error") {
      throw new Error(`armLobby settings rejected: ${res.payload.code}`);
    }
  }
  for (const [i, s] of members.entries()) {
    const cid = `${ns}-ready-${i}`;
    s.sendCmd(room.roomId, cid, "setReady", { ready: true });
    const ack = await s.next(ackOrError(cid));
    if (ack.type === "error") throw new Error(`armLobby ready rejected: ${ack.payload.code}`);
  }
};

// Arm the lobby and fire startGame from the host in one step — keeps the
// start-gate preamble to a single call site line in every game test.
// The settings payload goes through updateLobby first (Task 26).
export const armedStart = async (
  room: Created,
  members: readonly Sock[],
  commandId: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await armLobby(room, members, payload);
  members[0]?.sendCmd(room.roomId, commandId, "startGame", {});
};

type Waiter = {
  pred: (e: ServerEnvelope) => boolean;
  resolve: (e: ServerEnvelope) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// One real client socket: queues parsed server envelopes, records every
// frame in `log`, and tracks the room epoch from the last frame seen.
export class Sock {
  readonly log: ServerEnvelope[] = [];
  // Wall-clock receive time per logged frame (protocol-trace evidence).
  readonly stamps = new Map<ServerEnvelope, number>();
  epoch = 0;
  private readonly queue: ServerEnvelope[] = [];
  private readonly waiters: Waiter[] = [];
  private closedInfo: { code: number; reason: string } | null = null;
  private closeWaiters: ((i: { code: number; reason: string }) => void)[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => this.push(JSON.parse(String(e.data)) as ServerEnvelope));
    ws.addEventListener("close", (e) => {
      this.closedInfo = { code: e.code, reason: e.reason };
      for (const f of this.closeWaiters) f(this.closedInfo);
      this.closeWaiters = [];
    });
    ws.addEventListener("error", () => undefined);
  }

  static async connect(roomId: string, sessionToken: string): Promise<Sock> {
    const res = await post(`/api/rooms/${roomId}/ticket`, { sessionToken });
    if (res.status !== 200) throw new Error(`ticket failed: ${res.status}`);
    const { ticket } = (await res.json()) as { ticket: string };
    const up = await SELF.fetch(`${BASE}/api/rooms/${roomId}/ws?ticket=${ticket}`, {
      headers: { upgrade: "websocket", origin: GOOD_ORIGIN },
    });
    if (up.status !== 101 || up.webSocket === null) {
      throw new Error(`upgrade failed: ${up.status}`);
    }
    const sock = new Sock(up.webSocket);
    // Every admitted socket starts with a snapshot frame.
    const snapshot = await sock.next((e) => e.type === "snapshot");
    if (snapshot.type !== "snapshot") throw new Error("first frame was not a snapshot");
    // The compressed 800ms test lease would expire mid-test under suite
    // load — these sockets never heartbeat. Pin every lease an hour out;
    // presence tests overwrite it with their own values afterwards.
    await execSql(
      env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId)),
      "UPDATE room_players SET lease_until_ms = ?",
      Date.now() + 3_600_000,
    );
    return sock;
  }

  private push(env: ServerEnvelope): void {
    this.log.push(env);
    this.stamps.set(env, Date.now());
    this.epoch = env.gameEpoch;
    const index = this.waiters.findIndex((w) => w.pred(env));
    if (index >= 0) {
      const [w] = this.waiters.splice(index, 1);
      if (w !== undefined) {
        clearTimeout(w.timer);
        w.resolve(env);
      }
    } else {
      this.queue.push(env);
    }
  }

  // The 12s default covers full-suite parallelism: workerd serializes all
  // DO work in one process, and presence adds a sweep commit per message.
  next(pred: (e: ServerEnvelope) => boolean = () => true, ms = 12_000): Promise<ServerEnvelope> {
    const index = this.queue.findIndex(pred);
    if (index >= 0) {
      const [e] = this.queue.splice(index, 1);
      if (e !== undefined) return Promise.resolve(e);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), ms);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  count(pred: (e: ServerEnvelope) => boolean): number {
    return this.log.filter(pred).length;
  }

  sendEnvelope(env: ClientEnvelope): void {
    this.ws.send(JSON.stringify(env));
  }

  // Build a full client envelope for this socket's room/epoch.
  cmd(
    roomId: string,
    commandId: string,
    type: ClientEnvelope["type"],
    payload: ClientEnvelope["payload"] = {},
  ): ClientEnvelope {
    return {
      protocolVersion: 1,
      commandId,
      gameId: roomId,
      expectedGameEpoch: this.epoch,
      type,
      payload,
    } as ClientEnvelope;
  }

  sendCmd(
    roomId: string,
    commandId: string,
    type: ClientEnvelope["type"],
    payload: ClientEnvelope["payload"] = {},
  ): void {
    this.sendEnvelope(this.cmd(roomId, commandId, type, payload));
  }

  sendRaw(data: string | ArrayBuffer): void {
    this.ws.send(data);
  }
  waitClose(ms = 5_000): Promise<{ code: number; reason: string }> {
    if (this.closedInfo !== null) return Promise.resolve(this.closedInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), ms);
      this.closeWaiters.push((i) => {
        clearTimeout(timer);
        resolve(i);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}
