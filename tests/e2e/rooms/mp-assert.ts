// Task 23 e2e assertions: what "identical across contexts" means. The
// gate requires the same persisted outcome frame (winner/epoch/revision),
// the same ordered event stream (post-start digest) and the same sync
// head on every client.
import { expect } from "@playwright/test";
import { collectProof, type Seat } from "./mp-bridge";

export const FINISHED = {
  kind: "event",
  type: "phaseChanged",
  eventType: "finished",
} as const;

export type Proof = NonNullable<Awaited<ReturnType<typeof collectProof>>>;

export const proofs = async (seats: Seat[]): Promise<Proof[]> =>
  (await Promise.all(seats.map(collectProof))).map((p, i) => {
    if (p === null) throw new Error(`seat ${i} lost its bridge view`);
    return p;
  });

// Post-start digest: seats join in order, so pre-start presence frames
// legitimately differ per context. From the first phaseChanged ("started")
// on, a healthy room's ordered stream is identical on every client.
const postStartDigest = (stream: readonly string[]): string => {
  const cut = stream.findIndex((e) => e.endsWith(":phaseChanged"));
  return stream.slice(cut === -1 ? 0 : cut).join(",");
};

export const expectIdentical = (ps: Proof[], digest = true): void => {
  const head = ps[0];
  for (const p of ps) {
    expect(p.finishedFrame).toEqual(head?.finishedFrame ?? null);
    expect(p.finished).toEqual(head?.finished ?? null);
    expect(p.lastEventSeq).toBe(head?.lastEventSeq ?? null);
    if (digest) expect(postStartDigest(p.stream)).toBe(postStartDigest(head?.stream ?? []));
  }
};
