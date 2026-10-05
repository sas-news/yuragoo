// Task 15: the pure helpers behind the /play host loop — URL params, the
// posts->AcceptedMessage mapping, latest-evaluated-distribution lookup, the
// settle claim, and the dominant-slot argmax. States come from the real
// reduce() via the Task 12 fixture helpers.
import { describe, expect, test } from "bun:test";
import { type GameState, reduce } from "@yuragoo/game-core";
import { type DecisionDistribution, parseChoiceId } from "@yuragoo/protocol";
import {
  choicesFor,
  dominanceOf,
  dominantSlot,
  samplesFor,
} from "../../../apps/web/src/local/scenario";
import {
  buildPostDecisionState,
  claimFor,
  dwellStep,
  latestEvaluatedDist,
  parseLocalParams,
  toAcceptedMessages,
} from "../../../apps/web/src/local/session";
import { current, post, started } from "../game/rules-helpers";

const ALL_CHOICES = choicesFor(6);
const dist = (weights: readonly number[]): DecisionDistribution[] =>
  weights.map((p, i) => ({
    choiceId: ALL_CHOICES[i]?.id ?? parseChoiceId("a"),
    probability: p,
  }));

const playingWithPost = (): GameState => {
  let s = started(4, { seed: 7 }, 5_000).state;
  s = post(s, current(s), 6_000, "たべたい").state;
  return s;
};

describe("parseLocalParams", () => {
  test("defaults: 4 players, turn, seed 7, mock provider, ja language", () => {
    const p = parseLocalParams("");
    expect(p).toMatchObject({
      language: "ja",
      players: 4,
      mode: "turn",
      seed: 7,
      evalKind: "mock",
      evalDelayMs: 0,
      failEval: false,
    });
    expect(p.turnSeconds).toBeUndefined();
  });

  test("the device language seeds the local room language", () => {
    expect(parseLocalParams("", "en").language).toBe("en");
    expect(parseLocalParams("players=3", "en").players).toBe(3);
  });

  test("reads players/mode/seed/eval knobs and clamps ranges", () => {
    const p = parseLocalParams("players=6&mode=live&seed=42&eval=live&evalDelay=2500&failEval=1");
    expect(p).toMatchObject({
      players: 6,
      mode: "live",
      seed: 42,
      evalKind: "live",
      evalDelayMs: 2500,
      failEval: true,
    });
    expect(parseLocalParams("players=99").players).toBe(6);
    expect(parseLocalParams("players=abc").players).toBe(4);
    expect(parseLocalParams("turn=3&dwell=9&settle=5&rounds=2&live=90")).toMatchObject({
      turnSeconds: 3,
      adhesionSeconds: 9,
      settleSeconds: 5,
      rounds: 2,
      liveSeconds: 90,
    });
  });

  test("grace defaults to 3 and clamps to >=1", () => {
    expect(parseLocalParams("").grace).toBe(3);
    expect(parseLocalParams("grace=2").grace).toBe(2);
    expect(parseLocalParams("grace=0").grace).toBe(1);
    expect(parseLocalParams("grace=abc").grace).toBe(3);
  });
});

describe("choicesFor / samplesFor / dominantSlot", () => {
  test("choicesFor returns the first N choices with slot-consistent symbols", () => {
    expect(choicesFor(4).map((c) => String(c.id))).toEqual(["a", "b", "c", "d"]);
    expect(choicesFor(4).map((c) => c.symbol)).toEqual(["○", "◇", "△", "□"]);
    expect(choicesFor(6)).toHaveLength(6);
    expect(choicesFor(9)).toHaveLength(6); // pool capped
  });

  test("samplesFor maps distribution weights onto canonical slot angles", () => {
    const d = dist([0.7, 0.1, 0.1, 0.1]);
    const samples = samplesFor(d, 4);
    expect(samples).toHaveLength(4);
    expect(samples[0]?.weight).toBeCloseTo(0.7);
    expect(samplesFor(null, 4).every((s) => Math.abs(s.weight - 0.25) < 1e-9)).toBe(true);
    expect(samplesFor(null, 2)).toHaveLength(2);
  });

  test("dominantSlot is argmax with ties broken toward the lower index", () => {
    expect(dominantSlot(dist([0.1, 0.7, 0.1, 0.1]))).toBe(1);
    expect(dominantSlot(dist([0.5, 0.5, 0, 0]))).toBe(0);
  });
});

describe("dominanceOf / dwellStep", () => {
  const clear = (slot: number): DecisionDistribution[] =>
    dist([0.1, 0.1, 0.1, 0.1].map((p, i) => (i === slot ? 0.7 : p)));

  test("dominanceOf needs a >= 0.15 top-2 margin to count as dominant", () => {
    expect(dominanceOf(dist([0.7, 0.1, 0.1, 0.1]))).toBe(0);
    expect(dominanceOf(dist([0.1, 0.6, 0.2, 0.1]))).toBe(1);
    expect(dominanceOf(dist([0.4, 0.25, 0.2, 0.15]))).toBe(0); // exactly 0.15
    expect(dominanceOf(dist([0.4, 0.3, 0.2, 0.1]))).toBeNull(); // 0.1 margin
    expect(dominanceOf(dist([0.45, 0.45, 0.05, 0.05]))).toBeNull(); // knife-edge
    expect(dominanceOf(dist([0.25, 0.25, 0.25, 0.25]))).toBeNull(); // uniform
    expect(dominanceOf([])).toBeNull();
  });

  test("a dominant eval starts the streak and re-reports adhere", () => {
    expect(dwellStep({ slot: null, streak: 0 }, clear(2))).toEqual({
      slot: 2,
      streak: 1,
      adhere: 2,
      fire: false,
    });
  });

  test("the same slot accrues the streak and re-reports adhere every step", () => {
    const first = dwellStep({ slot: null, streak: 0 }, clear(0));
    const second = dwellStep(first, clear(0));
    // adhere is re-emitted even on the same slot — an accepted post clears
    // the reducer's adhesion, so skipping it was the stuck-dwell bug.
    expect(second).toEqual({ slot: 0, streak: 2, adhere: 0, fire: false });
  });

  test("a different dominant slot restarts the streak at 1", () => {
    const s1 = dwellStep({ slot: null, streak: 0 }, clear(0));
    const s2 = dwellStep(s1, clear(0));
    expect(dwellStep(s2, clear(3))).toEqual({ slot: 3, streak: 1, adhere: 3, fire: false });
  });

  test("unclear or missing dists reset the streak", () => {
    const s1 = dwellStep({ slot: null, streak: 0 }, clear(0));
    const s2 = dwellStep(s1, clear(0));
    expect(dwellStep(s2, dist([0.4, 0.3, 0.2, 0.1]))).toEqual({
      slot: null,
      streak: 0,
      adhere: null,
      fire: false,
    });
    expect(dwellStep(s2, null)).toEqual({ slot: null, streak: 0, adhere: null, fire: false });
  });

  test("fires once the streak reaches grace (default 3)", () => {
    let s = dwellStep({ slot: null, streak: 0 }, clear(1));
    s = dwellStep(s, clear(1));
    expect(s.fire).toBe(false); // 2 < 3 — still inside the grace window
    s = dwellStep(s, clear(1));
    expect(s).toMatchObject({ slot: 1, streak: 3, adhere: 1, fire: true });
    expect(dwellStep(s, clear(1)).fire).toBe(true); // keeps firing while dominant
  });

  test("grace=2 fires on the second straight dominant eval", () => {
    const s1 = dwellStep({ slot: null, streak: 0 }, clear(0), 2);
    expect(s1.fire).toBe(false);
    expect(dwellStep(s1, clear(0), 2).fire).toBe(true);
  });
});

describe("toAcceptedMessages / latestEvaluatedDist / claimFor", () => {
  test("a post becomes a message advocating the poster's own slot choice", () => {
    const s = playingWithPost();
    const poster = s.roster.find((p) => p.id === s.posts[0]?.playerId);
    const messages = toAcceptedMessages(s.posts, s.roster);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.choiceId).toBe(choicesFor(4)[poster?.slot ?? -1]?.id);
    expect(messages[0]?.inputSeq).toBe(1);
  });

  test("latestEvaluatedDist takes the newest evaluated post inside the cutoff", () => {
    let s = playingWithPost();
    s = post(s, current(s), 7_000, "ふたつめ").state;
    const d1 = dist([0.7, 0.1, 0.1, 0.1]);
    const d2 = dist([0.1, 0.1, 0.7, 0.1]);
    const dists = new Map([
      ["p1", d1],
      ["p2", d2],
    ] as const);
    // Still pending: nothing is returned yet.
    expect(latestEvaluatedDist(s.posts, dists)).toBeNull();
    s = reduce(s, { type: "evaluated", postId: "p1" }).state;
    s = reduce(s, { type: "evaluated", postId: "p2" }).state;
    expect(latestEvaluatedDist(s.posts, dists)).toBe(d2);
    expect(latestEvaluatedDist(s.posts, dists, 1)).toBe(d1); // cutoff honored
    expect(latestEvaluatedDist(s.posts, dists, 0)).toBeNull();
  });

  test("claimFor wins on the newest dist inside the cutoff, else budget", () => {
    let s = playingWithPost();
    s = reduce(s, { type: "evaluated", postId: "p1" }).state;
    const dists = new Map([["p1", dist([0.1, 0.1, 0.7, 0.1])]] as const);
    expect(claimFor(s, dists)).toEqual({ kind: "winner", slot: 2 });
    expect(claimFor(s, new Map())).toEqual({ kind: "noContest", reason: "budget" });
  });
});

describe("buildPostDecisionState", () => {
  test("carries scenario, N choices, bounded context and the favor key", () => {
    const s = playingWithPost();
    const first = s.posts[0];
    if (first === undefined) throw new Error("no post");
    const ds = buildPostDecisionState(s, first);
    const poster = s.roster.find((p) => p.id === first.playerId);
    expect(ds.scenario).toContain("食べ物");
    expect(ds.choices.map((c) => String(c.id))).toEqual(["a", "b", "c", "d"]);
    expect(ds.mockScenarioKey).toBe(`favor-${choicesFor(4)[poster?.slot ?? -1]?.id}`);
    expect(ds.activeContext).toContain("たべたい");
    expect(ds.language).toBe("ja");
  });

  test("en language carries English scenario/persona/labels", () => {
    const s = playingWithPost();
    const first = s.posts[0];
    if (first === undefined) throw new Error("no post");
    const ds = buildPostDecisionState(s, first, "en");
    expect(ds.language).toBe("en");
    expect(ds.scenario).toContain("Snack");
    expect(ds.persona).toContain("sweet tooth");
    expect(ds.choices.map((c) => String(c.id))).toEqual(["a", "b", "c", "d"]);
    expect(ds.choices.every((c) => /[\p{ASCII}]/u.test(c.label))).toBe(true);
  });
});
