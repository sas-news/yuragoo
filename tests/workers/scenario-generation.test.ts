// Task 44: one-shot AI scenario (お題) generation — same host-only,
// click-only, proposal-not-write contract as choices, on its OWN slot so
// one lobby can spend both assists. Real WebSocketPair + real DOs; only
// the provider is injected.
import { afterEach, expect, test } from "vitest";
import { env } from "cloudflare:test";
import type { GenerationRequest, GenerativeProvider } from "@yuragoo/ai";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { injectGenerationDeps } from "../../apps/server/src/rooms/generation-deps";
import { utcDay } from "../../apps/server/src/control/budgets";
import { controlStub } from "./budget-helpers";
import { must } from "./room-helpers";
import { latestLobby, setupRoom, Sock } from "./ws-helpers";

const isType = (type: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === type;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;

interface Stub extends GenerativeProvider {
  calls: number;
  lastKind: string | null;
}
const stubProvider = (): Stub => {
  const stub: Stub = {
    calls: 0,
    lastKind: null,
    async generate(req: GenerationRequest): Promise<unknown> {
      stub.calls += 1;
      stub.lastKind = req.kind;
      return { scenario: "嵐の日のかくれんぼ大会" };
    },
  };
  return stub;
};

const roomStubOf = (roomId: string) => env.GAME_ROOM.get(env.GAME_ROOM.idFromString(roomId));
const DAY0 = Date.parse("2026-10-01T12:00:00Z");
let dayNo = 0;
const inject = (stub: Stub | null) => {
  dayNo += 1;
  const dayMs = DAY0 + dayNo * 86_400_000;
  injectGenerationDeps({
    ...(stub === null ? { provider: null } : { provider: stub }),
    nowMs: () => dayMs,
    timeoutMs: 10_000,
  });
  return utcDay(dayMs);
};
afterEach(() => injectGenerationDeps({ provider: null, control: null }));

const lobby = async (players: number) => {
  const { room, joins } = await setupRoom(players);
  const socks: Sock[] = [];
  for (const j of joins) socks.push(await Sock.connect(room.roomId, j.sessionToken));
  return { room, socks, host: must(socks[0], "host") };
};

test("happy: proposal carries the scenario + revision; apply rides updateLobbyContent", async () => {
  const stub = stubProvider();
  const day = inject(stub);
  const { room, socks, host } = await lobby(2);
  const before = must(latestLobby(host), "lobby").revision;
  host.sendCmd(room.roomId, "gs-1", "generateScenario", {});
  const landed = await Promise.all(socks.map((s) => s.next(isType("scenarioGenerated"))));
  const first = must(landed[0], "event");
  if (first.type !== "scenarioGenerated") throw new Error("bad frame");
  expect(first.payload.scenario).toBe("嵐の日のかくれんぼ大会");
  expect(first.payload.lobbyRevision).toBe(before);
  expect(stub.calls).toBe(1);
  expect(stub.lastKind).toBe("scenario");
  // The scenario slot row landed at send time; tryGenerationSlot probes
  // would SPEND a free slot, so the untouched choices slot is verified by
  // the next lobbyChanged's generationSpent flag below instead.
  expect(await roomStubOf(room.roomId).tryGenerationSlot("scenario")).toBe(false);
  // Apply = a normal revision-gated scenario patch.
  const l = must(latestLobby(host), "lobby");
  host.sendCmd(room.roomId, "apply", "updateLobbyContent", {
    scenario: first.payload.scenario,
    expectedLobbyRevision: l.revision,
  });
  const lc = await host.next(isType("lobbyChanged"));
  if (lc.type !== "lobbyChanged") throw new Error("bad frame");
  expect(lc.payload.scenario).toBe("嵐の日のかくれんぼ大会");
  expect(lc.payload.scenarioSpent).toBe(true);
  expect(lc.payload.generationSpent).toBe(false);
  const genRow = (await controlStub().ledger(day)).find((r) => r.kind === "generation");
  expect(genRow?.consumed).toBe(1);
  for (const s of socks) s.close();
});

test("gates: non-host rejects free; a spent slot refuses the second click", async () => {
  const stub = stubProvider();
  inject(stub);
  const { room, socks, host } = await lobby(2);
  const guest = must(socks[1], "guest");
  guest.sendCmd(room.roomId, "g", "generateScenario", {});
  expect((await guest.next(isError("not-host"))).type).toBe("error");
  expect(stub.calls).toBe(0);
  host.sendCmd(room.roomId, "h1", "generateScenario", {});
  await host.next(isType("scenarioGenerated"));
  host.sendCmd(room.roomId, "h2", "generateScenario", {});
  expect((await host.next(isError("generation-spent"))).type).toBe("error");
  expect(stub.calls).toBe(1);
  for (const s of socks) s.close();
});

test("failure: invalid provider output burns the slot and reports the scope", async () => {
  const bad: GenerativeProvider = { generate: async () => ({ unrelated: true }) };
  injectGenerationDeps({ provider: bad, nowMs: () => DAY0 + 99 * 86_400_000, timeoutMs: 10_000 });
  const { room, socks, host } = await lobby(2);
  host.sendCmd(room.roomId, "gs", "generateScenario", {});
  const f = await host.next(isType("generationFailed"));
  if (f.type !== "generationFailed") throw new Error("bad frame");
  expect(f.payload.code).toBe("generation-invalid");
  expect(f.payload.slotSpent).toBe(true);
  expect(f.payload.scope).toBe("scenario");
  // The burned slot is durable state — the next free try refuses.
  expect(await roomStubOf(room.roomId).tryGenerationSlot("scenario")).toBe(false);
  for (const s of socks) s.close();
});
