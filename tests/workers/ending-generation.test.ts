// Task 31: one-shot post-game ending-caption generation — reserve, the
// atomic "post" slot spend, provider under deadline, consume-always and
// the template once-only fallback. Real GameRoom/ControlPlane DOs; only
// the provider is injected per test. The settle commit's own waitUntil
// fires kickEnding (buildStory -> template endingReady -> the runner),
// so the fixture drives the REAL pipeline and driveEnding() joins the
// single-flight lane deterministically.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { GenerationRequest, GenerativeProvider } from "@yuragoo/ai";
import type { EndingStory } from "@yuragoo/protocol";
import { utcDay } from "../../apps/server/src/control/budgets";
import { injectGenerationDeps } from "../../apps/server/src/rooms/generation-deps";
import { controlStub, poll } from "./budget-helpers";
import { execSql, LIVE_SETTINGS, must, namedRoom, NOW, type RoomStub } from "./room-helpers";

interface Stub extends GenerativeProvider {
  calls: number;
  hold: boolean;
  go: boolean;
  lastRequest: GenerationRequest | null;
  release(): void;
}

// Panel eventIds arrive inside the request's own JSON schema enum — the
// stub answers for whatever events the room's real extractor picked.
const eventIdEnum = (req: GenerationRequest): number[] => {
  const node = req.jsonSchema as {
    properties?: { panels?: { items?: { properties?: { eventId?: { enum?: unknown } } } } };
  };
  const raw = node.properties?.panels?.items?.properties?.eventId?.enum;
  return Array.isArray(raw) ? raw.filter((v): v is number => typeof v === "number") : [];
};

const stubProvider = (reply: (ids: readonly number[]) => unknown): Stub => {
  const stub: Stub = {
    calls: 0,
    hold: false,
    go: false,
    lastRequest: null,
    release: () => {
      stub.go = true;
    },
    async generate(request: GenerationRequest, signal?: AbortSignal): Promise<unknown> {
      stub.calls += 1;
      stub.lastRequest = request;
      // "hold" polls a flag inside the DO's own I/O context — awaiting a
      // test-context promise trips workerd's cross-DO rule.
      signal?.addEventListener(
        "abort",
        () => {
          stub.go = true;
        },
        { once: true },
      );
      while (stub.hold && !stub.go) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return reply(eventIdEnum(request));
    },
  };
  return stub;
};

const okReply = (ids: readonly number[]): unknown => ({
  title: "よるのおやつだいさくせん",
  panels: ids.map((eventId) => ({ eventId, caption: `cap-${eventId}` })),
});

let dayNo = 0; // unique UTC day per call — budget rows never bleed over
const inject = (stub: Stub, timeoutMs = 10_000): string => {
  dayNo += 1;
  const dayMs = Date.parse("2026-11-01T12:00:00Z") + dayNo * 86_400_000;
  injectGenerationDeps({ provider: stub, nowMs: () => dayMs, timeoutMs });
  return utcDay(dayMs);
};
afterEach(() => injectGenerationDeps({ provider: null, control: null }));

// inject() must precede settle: the settle commit's own waitUntil kicks
// the real ending pipeline with whatever deps are then injected.
const openRoom = async (label: string): Promise<RoomStub> => {
  const { stub } = namedRoom(label);
  await stub.createRoom({ settings: LIVE_SETTINGS, playerIds: ["p1", "p2"], nowMs: NOW });
  await stub.apply({
    playerId: "p1",
    commandId: "end-1",
    fingerprint: "fp-end-1",
    action: { type: "request-end", playerId: "p1", nowMs: NOW + 1000 },
  });
  return stub;
};

// Settle, then await the "ending" drive lane — joinable while the
// waitUntil lane is mid-flight (same single-flight promise), a no-op
// when it already settled (ending row + spent slot = idempotent).
const finish = async (stub: RoomStub): Promise<void> => {
  await stub.apply({
    playerId: "p1",
    commandId: "settle-1",
    fingerprint: "fp-settle-1",
    action: { type: "settle", nowMs: NOW + 2000, claim: { kind: "winner", slot: 0 } },
  });
  await runInDurableObject(stub, (i) => i.driveEnding());
  const snap = await stub.snapshot();
  if (snap.phase !== "finished") throw new Error("fixture did not finish");
};

const storedEnding = async (stub: RoomStub): Promise<EndingStory | null> => {
  const row = (await execSql(stub, "SELECT panel FROM ending WHERE id = 1"))[0];
  return typeof row?.panel === "string" ? (JSON.parse(row.panel) as EndingStory) : null;
};

// Every endingReady payload in ledger order: [0] is the template frame
// kickEnding emits at finish; [1] exists only when generated copy lands.
const readyStories = async (stub: RoomStub): Promise<EndingStory[]> =>
  (await execSql(stub, "SELECT payload FROM events WHERE type = 'endingReady' ORDER BY seq")).map(
    (r) => JSON.parse(String(r.payload)) as EndingStory,
  );

const genLedger = async (day: string) =>
  (await controlStub().ledger(day)).find((r) => r.kind === "generation");

test("happy: generated title+captions land keyed by eventId over the template", async () => {
  const gen = stubProvider((ids) => okReply([...ids].reverse()));
  const day = inject(gen);
  const stub = await openRoom("end-happy");
  await finish(stub);
  const ready = await readyStories(stub);
  expect(ready).toHaveLength(2); // template frame first, generated second
  expect(ready[0]?.generated).toBe(false);
  expect(ready[1]?.generated).toBe(true);
  const template = must(ready[0], "template story");
  const stored = must(await storedEnding(stub), "ending row");
  expect(stored.generated).toBe(true);
  // The story-level title comes from the model; per-page template
  // titles, verbatim quotes and the panel order are left untouched.
  expect(stored.title).toBe("よるのおやつだいさくせん");
  expect(stored.panels.map((p) => p.eventId)).toEqual(template.panels.map((p) => p.eventId));
  expect(stored.panels.map((p) => p.caption)).toEqual(
    template.panels.map((p) => `cap-${p.eventId}`), // keyed by eventId, not array order
  );
  expect(stored.panels[0]?.title).toBe(template.panels[0]?.title);
  expect(stored.panels[0]?.quotes).toEqual(template.panels[0]?.quotes);
  // The model saw only the structured panel set — the winner's label
  // arrives pre-resolved; postIds and the full post log never leave.
  const req = must(gen.lastRequest, "request");
  expect(req.prompt).toContain('"winnerLabel":"選択肢1"');
  expect(req.prompt).toContain('"kind":"winner"');
  expect(req.prompt).not.toContain("postIds");
  expect(req.count).toBe(template.panels.length);
  expect(await genLedger(day)).toMatchObject({ reserved: 1, consumed: 1 });
});

// Each malformed shape rejects the whole result — partial coverage would
// mix template and generated prose, so the template story stays verbatim.
test("failure: malformed, unknown-event, over-cap and partial replies keep it", async () => {
  const replies: readonly ((ids: readonly number[]) => unknown)[] = [
    () => "not-json-at-all",
    (ids) => ({
      title: "たいとる",
      panels: ids.map((id) => ({ eventId: id + 100, caption: "c" })),
    }),
    (ids) => ({
      title: "たいとる",
      panels: ids.map((id, i) => ({
        eventId: id,
        caption: i === 0 ? "あ".repeat(81) : `c${i}`,
      })),
    }),
    (ids) => ({
      title: "たいとる",
      panels: ids.slice(1).map((id) => ({ eventId: id, caption: "c" })),
    }),
  ];
  for (const [ci, reply] of replies.entries()) {
    const gen = stubProvider(reply);
    const day = inject(gen);
    const stub = await openRoom(`end-bad-${ci}`);
    await finish(stub);
    const ready = await readyStories(stub);
    expect(ready).toHaveLength(1); // the once-only template frame stands
    const stored = must(await storedEnding(stub), "ending row");
    expect(stored.generated).toBe(false);
    expect(stored.title).toBe(ready[0]?.title);
    expect(stored.panels).toEqual(ready[0]?.panels);
    expect(await genLedger(day)).toMatchObject({ reserved: 1, consumed: 1 });
    expect(gen.calls).toBe(1);
  }
});

test("failure: provider timeout consumes the grant but writes nothing", async () => {
  const gen = stubProvider(okReply);
  gen.hold = true; // never resolves on its own — the 50ms deadline fires
  const day = inject(gen, 50);
  const stub = await openRoom("end-timeout");
  await finish(stub);
  gen.release();
  const ready = await readyStories(stub);
  expect(ready).toHaveLength(1);
  expect((await storedEnding(stub))?.generated).toBe(false);
  expect(await genLedger(day)).toMatchObject({ reserved: 1, consumed: 1 });
});

// A result that lands after the close/rematch race is discarded whole —
// the emit txn re-verifies the same gates as the send boundary.
test("failure: closed room and bumped epoch both discard the late result", async () => {
  for (const [i, mode] of (["closed", "epoch"] as const).entries()) {
    const gen = stubProvider(okReply);
    gen.hold = true;
    const day = inject(gen);
    const stub = await openRoom(`end-late-${i}`);
    await stub.apply({
      playerId: "p1",
      commandId: "settle-1",
      fingerprint: "fp-settle-1",
      action: { type: "settle", nowMs: NOW + 2000, claim: { kind: "winner", slot: 0 } },
    });
    expect(await poll(async () => gen.calls > 0)).toBe(true); // send boundary passed
    await runInDurableObject(stub, (inst) => {
      if (mode === "closed") {
        inst.markClosed();
      } else {
        const b = inst.booksView();
        if (b !== null) inst.setBooks({ meta: { ...b.meta, gameEpoch: 99 }, state: b.state });
      }
    });
    gen.release();
    await runInDurableObject(stub, (inst) => inst.driveEnding()); // joins the lane
    const ready = await readyStories(stub);
    expect(ready).toHaveLength(1);
    expect((await storedEnding(stub))?.generated).toBe(false);
    expect(await genLedger(day)).toMatchObject({ reserved: 1, consumed: 1 });
  }
});

test("slot: the 'post' generation slot is spent exactly once", async () => {
  const gen = stubProvider(okReply);
  const day = inject(gen);
  const stub = await openRoom("end-once");
  await finish(stub);
  await runInDurableObject(stub, (inst) => inst.driveEnding());
  // The spent slot row and the generated row both make a second kick a
  // no-op: no extra provider call, no third endingReady frame.
  expect(gen.calls).toBe(1);
  expect(await readyStories(stub)).toHaveLength(2);
  expect(await stub.tryGenerationSlot("post")).toBe(false);
  expect(await genLedger(day)).toMatchObject({ reserved: 1, consumed: 1 });
});
