// Task 19: the pure resync machine — ordered delivery, out-of-order
// buffering, gap detection, duplicate drops and snapshot healing.
import { describe, expect, test } from "bun:test";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { ingest, initSync, type SyncMachine } from "../../../apps/web/src/net/sync";

let eventSeq = 0;
const env = (type: ServerEnvelope["type"], seq: number, extra: object = {}): ServerEnvelope => {
  eventSeq = Math.max(eventSeq, seq);
  return {
    protocolVersion: 1,
    eventSeq: seq,
    stateRevision: seq,
    gameId: "room-1",
    gameEpoch: 1,
    serverTime: 1_000,
    type,
    payload: { event: { type: "turn", round: 0, playerId: "p1" }, phase: "playing", ...extra },
  } as ServerEnvelope;
};

const feed = (m: SyncMachine, e: ServerEnvelope) => ingest(m, e);

describe("room event sync machine", () => {
  test("in-order events apply immediately and advance lastSeq", () => {
    let m = initSync();
    const r1 = feed(m, env("phaseChanged", 1));
    expect(r1.ingest.kind).toBe("ordered");
    m = r1.machine;
    const r2 = feed(m, env("inputAccepted", 2));
    expect(r2.ingest.kind).toBe("ordered");
    if (r2.ingest.kind === "ordered") expect(r2.ingest.events).toHaveLength(1);
    expect(r2.machine.lastSeq).toBe(2);
    expect(r2.machine.buffered.size).toBe(0);
  });

  test("an out-of-order event opens a gap and buffers", () => {
    let m = initSync();
    m = feed(m, env("phaseChanged", 1)).machine;
    const r = feed(m, env("phaseChanged", 3));
    expect(r.ingest).toEqual({ kind: "gap", expected: 2, received: 3 });
    expect(r.machine.lastSeq).toBe(1);
    expect(r.machine.buffered.size).toBe(1);
  });

  test("the gap filler releases the buffered run in order", () => {
    let m = initSync();
    m = feed(m, env("phaseChanged", 1)).machine;
    m = feed(m, env("phaseChanged", 4)).machine; // buffered
    m = feed(m, env("phaseChanged", 3)).machine; // buffered
    const r = feed(m, env("phaseChanged", 2));
    expect(r.ingest.kind).toBe("ordered");
    if (r.ingest.kind === "ordered") {
      expect(r.ingest.events.map((e) => e.eventSeq)).toEqual([2, 3, 4]);
    }
    expect(r.machine.lastSeq).toBe(4);
    expect(r.machine.buffered.size).toBe(0);
  });

  test("duplicates are dropped without moving lastSeq", () => {
    let m = initSync();
    m = feed(m, env("phaseChanged", 1)).machine;
    m = feed(m, env("phaseChanged", 2)).machine;
    const r = feed(m, env("phaseChanged", 1));
    expect(r.ingest.kind).toBe("duplicate");
    expect(r.machine.lastSeq).toBe(2);
  });

  test("room-lifetime frames stay ordered — lobbyReopened must reach the fold", () => {
    // Regression: lobbyReopened missing from ORDERED silently dropped the
    // back-to-lobby broadcast (fold never ran, the result dialog stayed).
    let m = initSync();
    m = feed(m, env("phaseChanged", 1)).machine;
    for (const [i, type] of [
      "lobbyChanged",
      "lobbyReopened",
      "memberJoined",
      "memberLeft",
      "hostChanged",
      "presenceChanged",
      "choicesGenerated",
      "scenarioGenerated",
      "generationFailed",
      "decisionUpdated",
      "endingReady",
      "roomClosed",
    ].entries()) {
      const r = feed(m, env(type as ServerEnvelope["type"], 2 + i));
      expect(r.ingest.kind).toBe("ordered");
      m = r.machine;
    }
    expect(m.lastSeq).toBe(13);
  });

  test("acks and errors are control frames outside ordering", () => {
    const m = initSync();
    const ack = env("ack", 9, {
      commandId: "c1",
      accepted: true,
      inputSeq: 1,
      stateRevision: 2,
    });
    const r = feed(m, ack);
    expect(r.ingest.kind).toBe("control");
    expect(r.machine.lastSeq).toBe(0);
  });

  test("a snapshot heals lastSeq and replays only newer buffered events", () => {
    let m = initSync();
    m = feed(m, env("phaseChanged", 1)).machine;
    m = feed(m, env("phaseChanged", 5)).machine; // gap at 2
    const snap = env("snapshot", 3, {
      state: null,
      phase: "playing",
      inputSeq: 2,
      players: [],
    });
    const r = feed(m, snap);
    expect(r.ingest.kind).toBe("snapshot");
    if (r.ingest.kind === "snapshot") {
      expect(r.ingest.envelope.stateRevision).toBe(3);
      expect(r.ingest.replay).toHaveLength(0); // seq 5 is not contiguous yet
    }
    expect(r.machine.lastSeq).toBe(3);
    const r2 = feed(r.machine, env("phaseChanged", 4));
    expect(r2.ingest.kind).toBe("ordered");
    if (r2.ingest.kind === "ordered") {
      expect(r2.ingest.events.map((e) => e.eventSeq)).toEqual([4, 5]);
    }
    expect(r2.machine.lastSeq).toBe(5);
  });

  test("a snapshot drops buffered events already covered by its revision", () => {
    let m = initSync();
    m = feed(m, env("phaseChanged", 1)).machine;
    m = feed(m, env("phaseChanged", 4)).machine;
    m = feed(m, env("phaseChanged", 5)).machine;
    const snap = env("snapshot", 5, {
      state: null,
      phase: "playing",
      inputSeq: 2,
      players: [],
    });
    const r = feed(m, snap);
    expect(r.machine.lastSeq).toBe(5);
    expect(r.machine.buffered.size).toBe(0);
    if (r.ingest.kind === "snapshot") expect(r.ingest.replay).toHaveLength(0);
  });
});
