// Task 20: Backoff determinism/bounds, the auth helpers' error mapping,
// and the RoomConnection retry loop — driven through a stubbed fetch and
// a fake WebSocket so the whole reconnect lifecycle runs without a server.
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerEnvelope } from "@yuragoo/protocol";
import {
  Backoff,
  issueTicket,
  RoomAuthError,
  RoomConnection,
  rotateCredentials,
} from "../../../apps/web/src/net/reconnect";

type Listener = (e: { data?: string; code?: number; reason?: string }) => void;

// Minimal stand-in for the browser WebSocket: the RoomClient only needs
// addEventListener + send + close; tests drive open/message/close manually.
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  readonly url: string;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(): void {}
  close(): void {
    this.serverClose(1000, "client-close");
  }
  private fire(type: string, e: { data?: string; code?: number; reason?: string }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  open(): void {
    this.fire("open", {});
  }
  receive(env: ServerEnvelope): void {
    this.fire("message", { data: JSON.stringify(env) });
  }
  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Call {
  path: string;
  body: Record<string, unknown> | undefined;
}

// fetch stub: sequential ticket/reconnect answers, every call journaled.
const stubFetch = (opts: { reconnectStatus?: number } = {}) => {
  const calls: Call[] = [];
  let tickets = 0;
  let rotations = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined;
    calls.push({ path, body });
    if (path.endsWith("/ticket")) {
      tickets += 1;
      return jsonRes({ ticket: `t${tickets}` });
    }
    if (path.endsWith("/reconnect")) {
      if (opts.reconnectStatus !== undefined) {
        return jsonRes({ error: "room-expired" }, opts.reconnectStatus);
      }
      rotations += 1;
      return jsonRes({
        playerId: "p1",
        sessionToken: `s${rotations + 1}`,
        reconnectToken: `r${rotations + 1}`,
      });
    }
    return new Response("not-found", { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

const until = async (pred: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("probe timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

// Install the fake as the global WebSocket (RoomClient does `new WebSocket`)
// and return a restore hook for afterEach.
const stubSockets = (): (() => void) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  return () => {
    globalThis.WebSocket = original;
    FakeSocket.instances = [];
  };
};

const ORIGIN = "http://unit.test";
const creds = { playerId: "p1", sessionToken: "s1", reconnectToken: "r1" };
const fast = { initialMs: 1, maxMs: 3, seed: 7 };

const conn = (extra: { onReconnect?: () => void } = {}) =>
  new RoomConnection({
    roomId: "room-1",
    credentials: { ...creds },
    workerOrigin: ORIGIN,
    backoff: fast,
    ...extra,
  });

// connect() resolves on the socket's open event — drive the fake's open
// after the constructor registers it, then await the pending connect.
const connectAndOpen = async (c: RoomConnection): Promise<FakeSocket> => {
  const pending = c.connect();
  await until(() => FakeSocket.instances.length === 1);
  const ws = FakeSocket.instances[0];
  if (ws === undefined) throw new Error("socket missing");
  ws.open();
  await pending;
  return ws;
};

const restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore.splice(0)) r();
  FakeSocket.instances = [];
});

describe("Backoff", () => {
  test("the same seed reproduces the same delay sequence", () => {
    const a = new Backoff({ initialMs: 250, maxMs: 4_000, seed: 99 });
    const b = new Backoff({ initialMs: 250, maxMs: 4_000, seed: 99 });
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });
  test("each step is base * jitter in [0.5, 1.5) and the cap holds", () => {
    const b = new Backoff({ initialMs: 250, maxMs: 4_000, seed: 1 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const base = Math.min(4_000, 250 * 2 ** attempt);
      const delay = b.next();
      expect(delay).toBeGreaterThanOrEqual(Math.round(base * 0.5));
      expect(delay).toBeLessThan(Math.round(base * 1.5) + 1);
    }
    b.reset();
    expect(b.next()).toBeLessThan(Math.round(250 * 1.5) + 1); // back to attempt 0
  });
});

describe("auth helpers", () => {
  test("issueTicket posts the session token and returns the ticket", async () => {
    const f = stubFetch();
    restore.push(f.restore);
    const ticket = await issueTicket(ORIGIN, "room-1", "s1");
    expect(ticket).toBe("t1");
    expect(f.calls[0]?.path).toBe("/api/rooms/room-1/ticket");
    expect(f.calls[0]?.body).toEqual({ sessionToken: "s1" });
  });
  test("rotateCredentials maps a 410 body error onto RoomAuthError", async () => {
    const f = stubFetch({ reconnectStatus: 410 });
    restore.push(f.restore);
    const err = await rotateCredentials(ORIGIN, "room-1", "r1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomAuthError);
    expect((err as RoomAuthError).status).toBe(410);
    expect((err as RoomAuthError).code).toBe("room-expired");
  });
});

describe("RoomConnection", () => {
  test("a dropped socket rotates credentials and re-admits once", async () => {
    const f = stubFetch();
    restore.push(f.restore, stubSockets());
    let reconnects = 0;
    const c = conn({ onReconnect: () => (reconnects += 1) });
    const first = await connectAndOpen(c);
    first.serverClose(1006, "dropped");
    await until(() => FakeSocket.instances.length === 2);
    FakeSocket.instances[1]?.open();
    await until(() => reconnects === 1);
    const paths = f.calls.map((x) => x.path);
    expect(paths).toEqual([
      "/api/rooms/room-1/ticket",
      "/api/rooms/room-1/reconnect",
      "/api/rooms/room-1/ticket",
    ]);
    expect(f.calls[1]?.body).toEqual({ reconnectToken: "r1" });
    expect(f.calls[2]?.body).toEqual({ sessionToken: "s2" });
    expect(c.credentials.reconnectToken).toBe("r2");
    c.stop();
  });
  test("a 4xx from /reconnect ends the loop permanently", async () => {
    const f = stubFetch({ reconnectStatus: 410 });
    restore.push(f.restore, stubSockets());
    const c = conn();
    const ws = await connectAndOpen(c);
    ws.serverClose(1006, "dropped");
    await until(() => c.finished);
    await new Promise((r) => setTimeout(r, 30)); // no further retries queue up
    expect(f.calls.filter((x) => x.path.endsWith("/reconnect")).length).toBe(1);
    expect(FakeSocket.instances.length).toBe(1);
  });
  test("a roomClosed frame is terminal: the close event triggers no retry", async () => {
    const f = stubFetch();
    restore.push(f.restore, stubSockets());
    const c = conn();
    const ws = await connectAndOpen(c);
    ws.receive({
      protocolVersion: 1,
      eventSeq: 1, // first ordered event — anything higher is buffered as a gap
      stateRevision: 1,
      gameId: "room-1",
      gameEpoch: 1,
      serverTime: 1,
      type: "roomClosed",
      payload: { reason: "host-closed" },
    } as ServerEnvelope);
    ws.serverClose(1000, "room-closed");
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.length).toBe(1); // only the first /ticket
    expect(c.finished).toBe(true);
  });
  test("stop() is a deliberate close: no retry lane ever opens", async () => {
    const f = stubFetch();
    restore.push(f.restore, stubSockets());
    const c = conn();
    await connectAndOpen(c);
    c.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.length).toBe(1);
    expect(c.finished).toBe(true);
  });
});
