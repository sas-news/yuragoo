// Task 27: the canvas's DOM state alternative stays non-numeric and
// tracks only meaningful changes — direction words, never numbers.
import { describe, expect, test } from "bun:test";
import type { CreaturePresentation } from "@yuragoo/creature";
import { describeCreature } from "../../../apps/web/src/game/creatureStatus";

const presentation = (weights: readonly number[]): CreaturePresentation => ({
  samples: weights.map((weight, i) => ({ angleRad: i, weight })),
  expression: "rest",
  reducedMotion: false,
});

describe("describeCreature", () => {
  test("visual states map to non-numeric state words", () => {
    expect(describeCreature("loading", undefined)).toBe("よみこみちゅう…");
    expect(describeCreature("error", undefined)).toContain("うまくいかなかった");
    expect(describeCreature("hesitating", undefined)).toContain("かんがえている");
    expect(describeCreature("bored", undefined)).toContain("たいくつ");
  });

  test("a dominant slot names its direction without numbers", () => {
    const text = describeCreature("normal", presentation([0.7, 0.1, 0.1, 0.1]));
    expect(text).toContain("○A");
    expect(text).toContain("のほうへ");
    expect(text).not.toMatch(/[0-9%]/);
  });

  test("uniform attraction is calm, not torn", () => {
    expect(describeCreature("normal", presentation([0.25, 0.25, 0.25, 0.25]))).toBe(
      "おちついている",
    );
    expect(describeCreature("normal", presentation([0.51, 0.49]))).toBe("おちついている");
  });

  test("a real near-tie reads as torn; a mild lead notes direction", () => {
    expect(describeCreature("normal", presentation([0.4, 0.36, 0.12, 0.12]))).toContain(
      "ゆれている",
    );
    expect(describeCreature("normal", presentation([0.4, 0.2, 0.2, 0.2]))).toContain(
      "すこしかたむいている",
    );
  });
});
