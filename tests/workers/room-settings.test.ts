// Task 26: shared lobby settings over real WebSocketPair clients.
// updateLobby is host-only, carries the contract menus, broadcasts the
// shared view to every member and clears every ready flag in one commit;
// startGame may only confirm the view, the reducer rejects the disabled
// switches outright, and the whole thing locks once the game exists.
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { armLobby, latestLobby, setupRoom, Sock } from "./ws-helpers";

const isType = (type: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === type;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;
const ackFor = (commandId: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === commandId;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = {
  mode: "turn",
  turnSeconds: 20,
  rounds: 3,
  liveSeconds: 120,
  earlyDecision: false,
  hostDecision: false,
};

const twoSocks = async () => {
  const { room, joins } = await setupRoom(2);
  const socks: Sock[] = [];
  for (const j of joins) socks.push(await Sock.connect(room.roomId, j.sessionToken));
  const [host, guest] = socks;
  if (host === undefined || guest === undefined) throw new Error("socks missing");
  return { room, host, guest, socks };
};

test("lobby settings: shared view, host-only patch, ready reset, start lock", async () => {
  const { room, host, guest, socks } = await twoSocks();
  expect(latestLobby(host)?.settings).toEqual(DEFAULTS);
  expect(latestLobby(guest)?.settings).toEqual(DEFAULTS); // guests see them too

  guest.sendCmd(room.roomId, "g-set", "updateLobby", { mode: "live" });
  expect((await guest.next(isError("not-host"))).type).toBe("error");
  // A rogue client's off-menu value must die at the schema boundary.
  host.sendCmd(room.roomId, "bad-set", "updateLobby", { turnSeconds: 15 } as never);
  expect((await host.next(isError("invalid-envelope"))).type).toBe("error");
  expect(latestLobby(host)?.settings).toEqual(DEFAULTS); // nothing moved

  host.sendCmd(room.roomId, "set-1", "updateLobby", {
    mode: "live",
    liveSeconds: 60,
    earlyDecision: true,
  });
  const landed = await Promise.all(socks.map((s) => s.next(isType("lobbyChanged"))));
  for (const e of landed) {
    if (e.type !== "lobbyChanged") throw new Error("not a lobbyChanged");
    expect(e.payload.settings).toEqual({
      ...DEFAULTS,
      mode: "live",
      liveSeconds: 60,
      earlyDecision: true,
    });
  }
  for (const [i, s] of socks.entries()) {
    s.sendCmd(room.roomId, `r-${i}`, "setReady", { ready: true });
    await s.next(ackFor(`r-${i}`));
  }
  await host.next((e) => e.type === "lobbyChanged" && e.payload.ready.length === 2);
  host.sendCmd(room.roomId, "set-2", "updateLobby", { hostDecision: true });
  const cleared = await host.next(
    (e) => e.type === "lobbyChanged" && e.payload.settings.hostDecision === true,
  );
  if (cleared.type !== "lobbyChanged") throw new Error("not a lobbyChanged");
  expect(cleared.payload.ready).toEqual([]); // every ready flag died together

  // A no-op patch is ack-only — the revision and ready flags never move.
  for (const [i, s] of socks.entries()) {
    s.sendCmd(room.roomId, `rr-${i}`, "setReady", { ready: true });
    await s.next(ackFor(`rr-${i}`));
  }
  await host.next((e) => e.type === "lobbyChanged" && e.payload.ready.length === 2);
  const frames = host.log.length;
  host.sendCmd(room.roomId, "noop", "updateLobby", { hostDecision: true });
  await host.next(ackFor("noop"));
  await sleep(200); // long enough for a broadcast that must never come
  expect(host.log.slice(frames).some(isType("lobbyChanged"))).toBe(false);
  expect(latestLobby(host)?.ready).toHaveLength(2);

  host.sendCmd(room.roomId, "s-bad", "startGame", { mode: "turn" });
  expect((await host.next(isError("settings-mismatch"))).type).toBe("error");
  await armLobby(room, socks); // content + ready at the current revision
  host.sendCmd(room.roomId, "go", "startGame", {});
  await host.next(ackFor("go"));
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromString(room.roomId));
  const view = await stub.snapshot();
  expect(view.state.settings).toMatchObject({
    mode: "live",
    liveSeconds: 60,
    earlyDecision: true,
    hostDecision: true,
  });
  host.sendCmd(room.roomId, "late", "updateLobby", { mode: "turn" });
  expect((await host.next(isError("bad-state"))).type).toBe("error");
  for (const s of socks) s.close();
});

test("lobby settings: disabled switches reject through the normal command path", async () => {
  const { room, host, socks } = await twoSocks();
  await armLobby(room, socks); // defaults: both switches OFF
  host.sendCmd(room.roomId, "go", "startGame", {});
  await host.next(ackFor("go"));
  host.sendCmd(room.roomId, "req", "requestDecision", {});
  expect((await host.next(isError("bad-state"))).type).toBe("error");
  for (const s of socks) s.close();
});
