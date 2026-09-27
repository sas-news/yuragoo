// Task 40: host-first turn ordering — the roster cycle is rotated so the
// room host (settings.hostId, server-derived at create) opens every round.
// Seats follow the arena's canonical slot angles, so roster order IS the
// clockwise sweep; rotating it to lead with the host gives the requested
// "ホストから時計回り" without changing the cycle itself.
import { expect, test } from "bun:test";
import type { GameState } from "@yuragoo/game-core";
import { created, ids, pass, started } from "./rules-helpers";

test("happy: the host takes the first turn, then the order sweeps the roster", () => {
  const s = created(4, { hostId: ids(4)[2] ?? "" }); // host = mugi pre-shuffle
  expect(s.turnOrder[0]).toBe("mugi");
  const idx = s.roster.findIndex((p) => p.id === "mugi");
  const expected = s.roster.map((_, i) => s.roster[(idx + i) % s.roster.length]?.id ?? "");
  expect(s.turnOrder).toEqual(expected);
});

test("happy: a mid-roster host still leads and round 2 keeps the same order", () => {
  const s = started(4, { hostId: "aiko" }).state;
  expect(s.turnOrder[0]).toBe("aiko");
  // Rounds re-derive the order — the host opens every round, not just the
  // first (the round-2 turnOrder must equal round-0's rotated cycle).
  let cur: GameState = s;
  for (let i = 0; i < 4; i += 1) cur = pass(cur, cur.deadlineAtMs).state;
  expect(cur.round).toBe(1);
  expect(cur.turnOrder).toEqual(s.turnOrder);
});

test("happy: no hostId falls back to plain roster order", () => {
  // Omitting hostId resolves to playerIds[0] (the room creator) — so the
  // default game also leads with the creator, and a roster position mid
  // cycle still rotates cleanly.
  const s = created(4);
  expect(s.turnOrder[0]).toBe("aiko");
});
