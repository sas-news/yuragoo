import { describe, expect, test } from "bun:test";
import { expressionFor } from "../../../apps/web/src/lobby/room-expression";

const dist = (ps: readonly number[]) =>
  ps.map((p, i) => ({ choiceId: `c${i}` as never, probability: p }));

describe("expressionFor", () => {
  test("no verdict reads as rest", () => {
    expect(expressionFor(null, 4, 60_000, 3)).toBe("rest");
    expect(expressionFor([], 4, 60_000, 3)).toBe("rest");
  });
  test("a dominating pull reads as adhering", () => {
    expect(expressionFor(dist([0.8, 0.1, 0.1]), 3, 0, 0)).toBe("adhering");
  });
  test("a clear lean reads as engaged", () => {
    expect(expressionFor(dist([0.6, 0.3, 0.1]), 3, 0, 0)).toBe("engaged");
  });
  test("a fresh flat pull reads as hesitating", () => {
    expect(expressionFor(dist([0.34, 0.33, 0.33]), 3, 2_000, 0)).toBe("hesitating");
  });
  test("a stale flat pull reads as bored", () => {
    expect(expressionFor(dist([0.34, 0.33, 0.33]), 3, 20_000, 0)).toBe("bored");
    // round >= 1 also qualifies without the idle wait
    expect(expressionFor(dist([0.34, 0.33, 0.33]), 3, 0, 2)).toBe("bored");
  });
  test("a mid-strength pull stays hesitating", () => {
    expect(expressionFor(dist([0.42, 0.33, 0.25]), 3, 60_000, 4)).toBe("hesitating");
  });
});
