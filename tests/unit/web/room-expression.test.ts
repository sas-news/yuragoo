import { describe, expect, test } from "bun:test";
import { expressionFor } from "../../../apps/web/src/lobby/room-expression";

const dist = (ps: readonly number[]) =>
  ps.map((p, i) => ({ choiceId: `c${i}` as never, probability: p }));

describe("expressionFor", () => {
  test("no verdict reads as rest", () => {
    expect(expressionFor(null, null, 4, 60_000, 3)).toBe("rest");
    expect(expressionFor([], null, 4, 60_000, 3)).toBe("rest");
  });
  test("a dominating pull reads as adhering", () => {
    expect(expressionFor(dist([0.8, 0.1, 0.1]), null, 3, 0, 0)).toBe("adhering");
  });
  test("a clear lean reads as engaged", () => {
    expect(expressionFor(dist([0.6, 0.3, 0.1]), null, 3, 0, 0)).toBe("engaged");
  });
  test("a fresh flat pull reads as hesitating", () => {
    expect(expressionFor(dist([0.34, 0.33, 0.33]), null, 3, 2_000, 0)).toBe("hesitating");
  });
  test("a stale flat pull reads as bored", () => {
    expect(expressionFor(dist([0.34, 0.33, 0.33]), null, 3, 20_000, 0)).toBe("bored");
    // round >= 1 also qualifies without the idle wait
    expect(expressionFor(dist([0.34, 0.33, 0.33]), null, 3, 0, 2)).toBe("bored");
  });
  test("a mid-strength pull stays hesitating", () => {
    expect(expressionFor(dist([0.42, 0.33, 0.25]), null, 3, 60_000, 4)).toBe("hesitating");
  });
});

describe("expressionFor — Jev mood verdict (Task 43)", () => {
  // Jev's picked mood is the model's own read of the context; it always
  // wins over the distribution-shape heuristic when a verdict carries one.
  test("a mood verdict wins over the shape heuristic", () => {
    // Flat pull that would read "bored" — Jev says the creature is hooked.
    expect(expressionFor(dist([0.34, 0.33, 0.33]), "adhering", 3, 60_000, 4)).toBe("adhering");
    // Dominant pull that would read "adhering" — Jev reads boredom.
    expect(expressionFor(dist([0.9, 0.1]), "bored", 2, 0, 0)).toBe("bored");
  });
  test("a mood verdict works with no distribution at all", () => {
    expect(expressionFor(null, "engaged", 4, 0, 0)).toBe("engaged");
  });
  test("every mood id maps straight through", () => {
    for (const mood of ["rest", "hesitating", "engaged", "bored", "adhering"] as const) {
      expect(expressionFor(null, mood, 2, 0, 0)).toBe(mood);
    }
  });
});
