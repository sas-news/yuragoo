// Pure resync / gap-detection logic for the room event stream (Task 19).
// No sockets here — feed parsed server envelopes in, get instructions out:
// apply events in order, buffer out-of-order arrivals, ask for a snapshot
// when a gap appears, heal from snapshots and replay the buffer.
//
// eventSeq is the persisted events-table seq; consecutive event envelopes
// must arrive gap-free. ack/error are control frames and never enter the
// ordering stream.
import type { ServerEnvelope } from "@yuragoo/protocol";

// Envelope types that carry ordered events (seq-tracked).
const ORDERED = new Set([
  "inputAccepted",
  "phaseChanged",
  "hostChanged",
  "presenceChanged",
  "decisionUpdated",
  "roomClosed",
  // Task 24: lobby ledger + membership rows share the events seq space.
  "lobbyChanged",
  "lobbyReopened",
  "memberJoined",
  "memberLeft",
  // Task 25: the generation outcome rows share the persisted stream.
  "choicesGenerated",
  "generationFailed",
  // Task 32: the kamishibai panel set shares the persisted event stream —
  // dropped frames here would leave the results screen stuck on "pending".
  "endingReady",
]);

export interface SyncMachine {
  // Highest contiguous eventSeq applied (or healed to by a snapshot).
  readonly lastSeq: number;
  // Buffered out-of-order events keyed by eventSeq, awaiting the gap fill.
  readonly buffered: ReadonlyMap<number, ServerEnvelope>;
}

export const initSync = (lastSeq = 0): SyncMachine => ({
  lastSeq,
  buffered: new Map<number, ServerEnvelope>(),
});

export type Ingest =
  // One or more contiguous events to apply in seq order (an in-order
  // arrival can also release a run of buffered successors).
  | { readonly kind: "ordered"; readonly events: readonly ServerEnvelope[] }
  | { readonly kind: "duplicate" }
  // A gap opened: the event was buffered; the caller should send syncRequest.
  | { readonly kind: "gap"; readonly expected: number; readonly received: number }
  // Control frames (ack/error) the caller handles outside ordering.
  | { readonly kind: "control"; readonly envelope: ServerEnvelope }
  // A snapshot arrived: apply it, then replay these now-contiguous buffered
  // events in seq order.
  | {
      readonly kind: "snapshot";
      readonly envelope: ServerEnvelope;
      readonly replay: readonly ServerEnvelope[];
    };

// Pull the contiguous run starting at `seq` out of the buffer.
const drain = (
  buffered: Map<number, ServerEnvelope>,
  seq: number,
): { readonly delivered: ServerEnvelope[]; readonly next: number } => {
  const delivered: ServerEnvelope[] = [];
  let next = seq;
  while (buffered.has(next)) {
    const env = buffered.get(next);
    if (env !== undefined) delivered.push(env);
    buffered.delete(next);
    next += 1;
  }
  return { delivered, next };
};

export const ingest = (
  machine: SyncMachine,
  envelope: ServerEnvelope,
): { readonly machine: SyncMachine; readonly ingest: Ingest } => {
  if (envelope.type === "snapshot") {
    const healed = envelope.stateRevision;
    const kept = new Map<number, ServerEnvelope>();
    // Anything at or below the healed revision is already inside the
    // snapshot; strictly newer contiguous entries replay in order.
    for (const [seq, env] of machine.buffered) {
      if (seq > healed) kept.set(seq, env);
    }
    const { delivered, next } = drain(kept, healed + 1);
    return {
      machine: { lastSeq: next - 1, buffered: kept },
      ingest: { kind: "snapshot", envelope, replay: delivered },
    };
  }
  if (!ORDERED.has(envelope.type)) {
    return { machine, ingest: { kind: "control", envelope } };
  }
  const expected = machine.lastSeq + 1;
  if (envelope.eventSeq <= machine.lastSeq) {
    return { machine, ingest: { kind: "duplicate" } };
  }
  if (envelope.eventSeq > expected) {
    const buffered = new Map(machine.buffered);
    buffered.set(envelope.eventSeq, envelope);
    return {
      machine: { ...machine, buffered },
      ingest: { kind: "gap", expected, received: envelope.eventSeq },
    };
  }
  const buffered = new Map(machine.buffered);
  const { delivered } = drain(buffered, envelope.eventSeq + 1);
  return {
    machine: { lastSeq: envelope.eventSeq + delivered.length, buffered },
    ingest: { kind: "ordered", events: [envelope, ...delivered] },
  };
};
