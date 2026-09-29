// Task 25: one-shot AI choice generation — slot + daily budget accounting,
// proposal-not-write semantics. Real WS clients + DOs; provider injected.
import { afterEach, expect, test } from "vitest";
import { env } from "cloudflare:test";
import type { GenerationRequest, GenerativeProvider } from "@yuragoo/ai";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { injectGenerationDeps } from "../../apps/server/src/rooms/generation-deps";
import { utcDay } from "../../apps/server/src/control/budgets";
import { controlStub, poll } from "./budget-helpers";
import { execSql, must } from "./room-helpers";
import { armLobby, joinRoom, latestLobby, setupRoom, Sock } from "./ws-helpers";

const isType = (type: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === type;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;

interface Stub extends GenerativeProvider {
  calls: number;
  mode: "ok" | "garbage" | "hold";
  go: boolean;
  release(): void;
}
const stubProvider = (): Stub => {
  const stub: Stub = {
    calls: 0,
    mode: "ok",
    go: false,
    release: () => {
      stub.go = true;
    },
    async generate(req: GenerationRequest, signal?: AbortSignal): Promise<unknown> {
      stub.calls += 1;
      // "hold" waits on a plain flag polled inside the DO's own I/O context.
      // Awaiting a promise resolved from the test context would trip
      // workerd's cross-DO I/O rule ("Promise will never complete").
      signal?.addEventListener("abort", () => (stub.go = true), { once: true });
      while (stub.mode === "hold" && !stub.go) {
        await new Promise((r) => setTimeout(r, 20));
      }
      if (stub.mode === "garbage") return "not-json-at-all";
      return { choices: Array.from({ length: req.count }, (_, i) => `生成案${i + 1}`) };
    },
  };
  return stub;
};

const roomStubOf = (roomId: string) => env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));
const DAY0 = Date.parse("2026-10-01T12:00:00Z");
let dayNo = 0;
const inject = (stub: Stub | null, timeoutMs = 10_000) => {
  dayNo += 1;
  const dayMs = DAY0 + dayNo * 86_400_000;
  injectGenerationDeps({
    ...(stub === null ? { provider: null } : { provider: stub }),
    nowMs: () => dayMs,
    timeoutMs,
  });
  return utcDay(dayMs);
};
afterEach(() => injectGenerationDeps({ provider: null, control: null }));

const lobby = async (players: number, scenario = true) => {
  const { room, joins } = await setupRoom(players);
  const socks: Sock[] = [];
  for (const j of joins) socks.push(await Sock.connect(room.roomId, j.sessionToken));
  const host = must(socks[0], "host");
  if (scenario) {
    const l = must(latestLobby(host), "lobby");
    host.sendCmd(room.roomId, "sc", "updateLobbyContent", {
      scenario: "夜のおやつ会議",
      expectedLobbyRevision: l.revision,
    });
    await host.next(isType("lobbyChanged"));
  }
  return { room, joins, socks, host };
};

test("happy: proposal carries the captured revision; host applies it", async () => {
  const stub = stubProvider();
  const day = inject(stub);
  const { room, socks, host } = await lobby(4);
  const before = must(latestLobby(host), "lobby").revision;
  host.sendCmd(room.roomId, "gen-1", "generateChoices", {});
  const landed = await Promise.all(socks.map((s) => s.next(isType("choicesGenerated"))));
  const first = must(landed[0], "event");
  if (first.type !== "choicesGenerated") throw new Error("bad frame");
  const p = first.payload;
  expect(p.lobbyRevision).toBe(before);
  expect(p.memberCount).toBe(4);
  expect(p.labels).toHaveLength(4);
  for (const l of p.labels) expect(l.length).toBeLessThanOrEqual(40);
  expect(stub.calls).toBe(1);
  // Apply rides the normal updateLobbyContent on the current revision.
  const cur = must(latestLobby(host), "lobby");
  host.sendCmd(room.roomId, "apply", "updateLobbyContent", {
    choices: cur.choices.map((c, i) => ({ choiceId: c.choiceId, label: p.labels[i] ?? "" })),
    expectedLobbyRevision: cur.revision,
  });
  const lc = await host.next(isType("lobbyChanged"));
  if (lc.type !== "lobbyChanged") throw new Error("bad frame");
  expect(lc.payload.choices.map((c) => c.label)).toEqual(p.labels);
  expect(lc.payload.generationSpent).toBe(true);
  expect(await roomStubOf(room.roomId).tryGenerationSlot("pre")).toBe(false);
  const genRow = (await controlStub().ledger(day)).find((r) => r.kind === "generation");
  expect(genRow?.reserved).toBe(1);
  expect(genRow?.consumed).toBe(1);
  for (const s of socks) s.close();
});

test("gates: non-host and empty scenario reject for free", async () => {
  const stub = stubProvider();
  inject(stub);
  const { room, socks, host } = await lobby(2, false);
  const guest = must(socks[1], "guest");
  guest.sendCmd(room.roomId, "g", "generateChoices", {});
  expect((await guest.next(isError("not-host"))).type).toBe("error");
  host.sendCmd(room.roomId, "h", "generateChoices", {});
  expect((await host.next(isError("lobby-scenario-empty"))).type).toBe("error");
  expect(stub.calls).toBe(0);
  for (const s of socks) s.close();
});

test("failure: invalid response consumes the slot; second click refused", async () => {
  const stub = stubProvider();
  stub.mode = "garbage";
  inject(stub);
  const { room, socks, host } = await lobby(2);
  host.sendCmd(room.roomId, "gen", "generateChoices", {});
  const f = await host.next(isType("generationFailed"));
  if (f.type !== "generationFailed") throw new Error("bad frame");
  expect(f.payload.code).toBe("generation-invalid");
  expect(f.payload.slotSpent).toBe(true);
  host.sendCmd(room.roomId, "gen2", "generateChoices", {});
  expect((await host.next(isError("generation-spent"))).type).toBe("error");
  expect(stub.calls).toBe(1);
  for (const s of socks) s.close();
});

test("failure: provider timeout consumes the slot", async () => {
  const stub = stubProvider();
  stub.mode = "hold"; // never released — the deadline fires instead
  inject(stub, 50);
  const { room, socks, host } = await lobby(2);
  host.sendCmd(room.roomId, "gen", "generateChoices", {});
  const f = await host.next(isType("generationFailed"));
  if (f.type !== "generationFailed") throw new Error("bad frame");
  expect(f.payload.code).toBe("generation-timeout");
  expect(f.payload.slotSpent).toBe(true);
  for (const s of socks) s.close();
});

test("roster moved mid-flight: proposal still lands; apply uses current revision", async () => {
  const stub = stubProvider();
  stub.mode = "hold";
  inject(stub);
  const { room, socks, host } = await lobby(3);
  const reqRev = must(latestLobby(host), "lobby").revision;
  host.sendCmd(room.roomId, "gen", "generateChoices", {});
  await host.next((e) => e.type === "ack" && e.payload.commandId === "gen");
  const late = await joinRoom(room); // member count 3 -> 4 mid-flight
  const lateSock = await Sock.connect(room.roomId, late.sessionToken);
  const moved = await host.next(isType("lobbyChanged"));
  if (moved.type !== "lobbyChanged") throw new Error("bad frame");
  expect(moved.payload.revision).toBeGreaterThan(reqRev);
  stub.release();
  const g = await host.next(isType("choicesGenerated"));
  if (g.type !== "choicesGenerated") throw new Error("bad frame");
  expect(g.payload.labels).toHaveLength(3); // request-time member count
  expect(g.payload.lobbyRevision).toBe(reqRev);
  // A stale-revision apply conflicts and writes nothing.
  host.sendCmd(room.roomId, "stale", "updateLobbyContent", {
    choices: moved.payload.choices.map((c, i) => ({
      choiceId: c.choiceId,
      label: g.payload.labels[i] ?? "",
    })),
    expectedLobbyRevision: g.payload.lobbyRevision,
  });
  expect((await host.next(isError("lobby-revision-conflict"))).type).toBe("error");
  // Applying on the current revision lands the 3 labels; c3 stays empty.
  const cur = must(latestLobby(host), "lobby");
  host.sendCmd(room.roomId, "apply", "updateLobbyContent", {
    choices: cur.choices.slice(0, 3).map((c, i) => ({
      choiceId: c.choiceId,
      label: g.payload.labels[i] ?? "",
    })),
    expectedLobbyRevision: cur.revision,
  });
  const lc = await host.next(isType("lobbyChanged"));
  if (lc.type !== "lobbyChanged") throw new Error("bad frame");
  expect(lc.payload.choices.slice(0, 3).map((c) => c.label)).toEqual(g.payload.labels);
  expect(lc.payload.choices[3]?.label).toBe("");
  lateSock.close();
  for (const s of socks) s.close();
});

test("late arrival after game start is discarded; grant still consumed", async () => {
  const stub = stubProvider();
  stub.mode = "hold";
  const day = inject(stub);
  const { room, socks, host } = await lobby(2);
  host.sendCmd(room.roomId, "gen", "generateChoices", {});
  await host.next((e) => e.type === "ack" && e.payload.commandId === "gen");
  await armLobby(room, socks, { mode: "live", seed: 5 }); // labels + settings + ready
  host.sendCmd(room.roomId, "go", "startGame", {});
  await host.next((e) => e.type === "ack" && e.payload.commandId === "go");
  stub.release();
  // The emit is discarded (books exist), but the sent attempt was spent.
  await poll(async () => {
    const row = (await controlStub().ledger(day)).find((r) => r.kind === "generation");
    return row?.consumed === 1;
  });
  const rows = (await execSql(roomStubOf(room.roomId), "SELECT type FROM events")).map(
    (r) => r.type,
  );
  expect(rows).not.toContain("choicesGenerated");
  expect(stub.calls).toBe(1);
  for (const s of socks) s.close();
});

test("double click: two commands race but only one attempt is sent", async () => {
  const stub = stubProvider();
  stub.mode = "hold";
  inject(stub);
  const { room, socks, host } = await lobby(2);
  host.sendCmd(room.roomId, "gen-a", "generateChoices", {});
  host.sendCmd(room.roomId, "gen-b", "generateChoices", {});
  stub.release();
  const g = await host.next(isType("choicesGenerated"));
  if (g.type !== "choicesGenerated") throw new Error("bad frame");
  expect(stub.calls).toBe(1);
  // The loser either errored at the gate or reported the spent slot.
  const spent = await host.next(
    (e) =>
      (e.type === "error" && e.payload.code === "generation-spent") ||
      (e.type === "generationFailed" && e.payload.code === "generation-spent"),
  );
  expect(spent.type === "error" || spent.type === "generationFailed").toBe(true);
  for (const s of socks) s.close();
});
