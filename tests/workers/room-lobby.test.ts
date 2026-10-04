// Task 24: the host-editable shared lobby — ledger persistence, revision
// locking, the ready/start gate, membership-driven choice growth and the
// orphan-draft lifecycle, end to end through real WebSocketPair clients.
import { expect, test } from "vitest";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { armLobby, createRoom, joinRoom, latestLobby, setupRoom, Sock } from "./ws-helpers";

const isType = (type: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === type;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;
const ackFor = (commandId: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === commandId;
const lobbyChanged = isType("lobbyChanged");
const lobbyOf = (e: ServerEnvelope) => {
  if (e.type !== "lobbyChanged") throw new Error("not a lobbyChanged frame");
  return e.payload;
};

const two = async (players = 2) => {
  const { room, joins } = await setupRoom(players);
  const socks: Sock[] = [];
  for (const j of joins) socks.push(await Sock.connect(room.roomId, j.sessionToken));
  return { room, joins, socks };
};

test("happy: host edits broadcast one lobbyChanged; ready+start lands playing", async () => {
  const { room, socks } = await two(4);
  const [host] = socks;
  if (host === undefined) throw new Error("host missing");
  const lobby = latestLobby(host);
  if (lobby === null) throw new Error("lobby missing");
  expect(lobby.choices.map((c) => c.choiceId)).toEqual(["c0", "c1", "c2", "c3"]);
  host.sendCmd(room.roomId, "edit-1", "updateLobbyContent", {
    scenario: "ゆらゆら夜食",
    choices: lobby.choices.map((c, i) => ({ choiceId: c.choiceId, label: `ラベル${i}` })),
    expectedLobbyRevision: lobby.revision,
  });
  const landed = await Promise.all(socks.map((s) => s.next(lobbyChanged)));
  const first = landed[0];
  if (first === undefined) throw new Error("lobbyChanged missing");
  const revisions = new Set(landed.map((e) => lobbyOf(e).revision));
  expect(revisions.size).toBe(1);
  expect(lobbyOf(first).scenario).toBe("ゆらゆら夜食");
  expect(lobbyOf(first).choices.map((c) => c.choiceId)).toEqual(["c0", "c1", "c2", "c3"]);
  // Task 26: the mode rides the shared settings view — startGame's
  // payload then only confirms what every member saw.
  host.sendCmd(room.roomId, "set-1", "updateLobby", { mode: "live", seed: 3 });
  await host.next(ackFor("set-1"));
  for (const [i, s] of socks.entries()) {
    s.sendCmd(room.roomId, `ready-${i}`, "setReady", { ready: true });
    await s.next(ackFor(`ready-${i}`));
  }
  await host.next((e) => e.type === "lobbyChanged" && e.payload.ready.length === 4);
  host.sendCmd(room.roomId, "start-1", "startGame", { mode: "live", seed: 3 });
  await host.next(ackFor("start-1"));
  for (const s of socks) await s.next(isType("phaseChanged"));
  for (const s of socks) s.close();
});

test("orphans: leave shrinks the roster but keeps drafts; rejoin reactivates them", async () => {
  const { room, joins, socks } = await two(4);
  const [host] = socks;
  if (host === undefined) throw new Error("host missing");
  const lobby = latestLobby(host);
  if (lobby === null) throw new Error("lobby missing");
  host.sendCmd(room.roomId, "edit-o", "updateLobbyContent", {
    scenario: "シナリオ",
    choices: lobby.choices.map((c, i) => ({ choiceId: c.choiceId, label: `ドラフト${i}` })),
    expectedLobbyRevision: lobby.revision,
  });
  await host.next(lobbyChanged);
  const leaver = joins[2];
  if (leaver === undefined) throw new Error("join missing");
  // Two members walk out: memberLeft rows broadcast, drafts stay put.
  for (const s of socks.slice(2)) s.sendCmd(room.roomId, "bye", "leave", {});
  const left = await Promise.all(
    socks
      .slice(0, 2)
      .map((s) => s.next((e) => e.type === "memberLeft" && e.payload.playerId === leaver.playerId)),
  );
  expect(left).toHaveLength(2);
  // Shrinking membership never rewrites the ledger — the last lobbyChanged
  // still carries all four drafts (the orphan tail is read-side only).
  const kept = latestLobby(host);
  expect(kept?.choices).toHaveLength(4);
  expect(kept?.choices[3]?.label).toBe("ドラフト3");
  // Two fresh members join: the orphan tail reactivates without a rewrite.
  // Each close vacates outright (lobby rule), so the NEXT joiner takes the
  // next-oldest orphan draft — ドラフト2 then ドラフト3.
  for (const label of ["ドラフト2", "ドラフト3"]) {
    const j = await joinRoom(room);
    const s = await Sock.connect(room.roomId, j.sessionToken);
    const snapLobby = latestLobby(s);
    expect(snapLobby?.choices).toHaveLength(4);
    expect(snapLobby?.choices[2]?.label).toBe(label);
    s.close();
    await host.next((e) => e.type === "memberLeft" && e.payload.playerId === j.playerId);
  }
  for (const s of socks) s.close();
});

test("gate: not-host, stale revision, empty/dup labels, unready, too few", async () => {
  // Non-host edits and stale revisions are refused before any write.
  const { room, socks } = await two(2);
  const [host, guest] = socks;
  if (host === undefined || guest === undefined) throw new Error("sockets missing");
  guest.sendCmd(room.roomId, "g-edit", "updateLobbyContent", {
    scenario: "乗っ取り",
    expectedLobbyRevision: 0,
  });
  expect((await guest.next(isError("not-host"))).type).toBe("error");
  const lobby = latestLobby(host);
  if (lobby === null) throw new Error("lobby missing");
  host.sendCmd(room.roomId, "h-edit", "updateLobbyContent", {
    scenario: "本物",
    expectedLobbyRevision: lobby.revision + 5,
  });
  expect((await host.next(isError("lobby-revision-conflict"))).type).toBe("error");
  expect(latestLobby(host)?.scenario).toBe(""); // nothing wrote

  // Not-ready and empty content block the start, in gate order.
  host.sendCmd(room.roomId, "s-1", "startGame", {});
  expect((await host.next(isError("lobby-not-ready"))).type).toBe("error");
  for (const [i, s] of socks.entries()) {
    s.sendCmd(room.roomId, `r-${i}`, "setReady", { ready: true });
    await s.next(ackFor(`r-${i}`));
  }
  host.sendCmd(room.roomId, "s-2", "startGame", {});
  expect((await host.next(isError("lobby-scenario-empty"))).type).toBe("error");
  const base = latestLobby(host);
  if (base === null) throw new Error("lobby missing");
  host.sendCmd(room.roomId, "e-1", "updateLobbyContent", {
    scenario: "ある",
    expectedLobbyRevision: base.revision,
  });
  await host.next(lobbyChanged);
  host.sendCmd(room.roomId, "s-3", "startGame", {});
  expect((await host.next(isError("lobby-choice-empty"))).type).toBe("error");
  const rev2 = latestLobby(host);
  if (rev2 === null) throw new Error("lobby missing");
  host.sendCmd(room.roomId, "e-2", "updateLobbyContent", {
    choices: rev2.choices.map((c) => ({ choiceId: c.choiceId, label: " 同じ " })),
    expectedLobbyRevision: rev2.revision,
  });
  await host.next(lobbyChanged);
  host.sendCmd(room.roomId, "s-4", "startGame", {});
  expect((await host.next(isError("lobby-choice-dup"))).type).toBe("error");
  for (const s of socks) s.close();

  // A one-member room can never start.
  const solo = await createRoom();
  const j = await joinRoom(solo);
  const alone = await Sock.connect(solo.roomId, j.sessionToken);
  alone.sendCmd(solo.roomId, "s-solo", "startGame", {});
  expect((await alone.next(isError("lobby-too-few"))).type).toBe("error");
  alone.close();
});

test("leave: the socket closes, memberLeft broadcasts, ready clears", async () => {
  const { room, joins, socks } = await two(3);
  const [host, , leaver] = socks;
  if (host === undefined || leaver === undefined) throw new Error("sockets missing");
  leaver.sendCmd(room.roomId, "r-0", "setReady", { ready: true });
  await leaver.next(ackFor("r-0"));
  const leaverJoin = joins[2];
  if (leaverJoin === undefined) throw new Error("join missing");
  const pid = leaverJoin.playerId;
  leaver.sendCmd(room.roomId, "bye-1", "leave", {});
  await leaver.next(ackFor("bye-1"));
  expect((await leaver.waitClose()).code).toBe(1000);
  await host.next((e) => e.type === "memberLeft" && e.payload.playerId === pid);
  const lc = await host.next((e) => e.type === "lobbyChanged" && !e.payload.ready.includes(pid));
  expect(lobbyOf(lc).ready).toHaveLength(0);
  for (const s of socks) s.close();
});

test("mid-game join sits out: lobbyWaiting member does not enter the gate", async () => {
  const { room, socks } = await two(2);
  const [host] = socks;
  if (host === undefined) throw new Error("host missing");
  await armLobby(room, socks, { mode: "live", seed: 5 });
  host.sendCmd(room.roomId, "go", "startGame", {});
  await host.next(ackFor("go"));
  const late = await joinRoom(room);
  expect(late.lobbyWaiting).toBe(true);
  await host.next((e) => e.type === "memberJoined" && e.payload.lobbyWaiting === true);
  const s = await Sock.connect(room.roomId, late.sessionToken);
  const snap = s.log.find((e) => e.type === "snapshot");
  if (snap?.type !== "snapshot") throw new Error("snapshot missing");
  expect(snap.payload.players).toHaveLength(3);
  expect(snap.payload.state?.roster).toHaveLength(2); // the game kept its seats
  s.close();
  for (const so of socks) so.close();
});
