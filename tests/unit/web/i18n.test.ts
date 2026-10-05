// i18n unit tests: locale normalization, JA-keyed translation with {vars}
// interpolation, missing-key fallback, and the EN dictionary's coverage —
// every t()/tx() source literal in product code must have a dictionary row.
import { describe, expect, test } from "bun:test";
import { EN } from "../../../apps/web/src/i18n/en";
import { normalizeLocale, tx } from "../../../apps/web/src/i18n/index";

describe("normalizeLocale", () => {
  test("maps ja/en tags and regional/underscore variants", () => {
    expect(normalizeLocale("ja")).toBe("ja");
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("en_US")).toBe("en");
    expect(normalizeLocale("EN-gb")).toBe("en");
  });

  test("rejects other languages and junk", () => {
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("zh-Hant")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });
});

describe("tx", () => {
  test("ja returns the source, interpolated", () => {
    expect(tx("ja", "プレイヤー{n}", { n: 3 })).toBe("プレイヤー3");
    expect(tx("ja", "そのまま")).toBe("そのまま");
  });

  test("en returns the dictionary entry, interpolated", () => {
    expect(tx("en", "プレイヤー{n}", { n: 3 })).toBe("Player 3");
    expect(tx("en", "{name} のターン（{round}巡目）", { name: "Ren", round: 2 })).toBe(
      "Ren's turn (round 2)",
    );
  });

  test("missing keys fall back to the JA source, still interpolated", () => {
    expect(tx("en", "辞書にない{n}文", { n: 9 })).toBe("辞書にない9文");
  });

  test("a missing var keeps its placeholder visible (loud over wrong)", () => {
    expect(tx("en", "{name} の勝ち！", {})).toBe("{name} wins!");
  });
});

describe("EN dictionary", () => {
  test("has no empty values and no leftover JA in translations", () => {
    for (const [key, value] of Object.entries(EN)) {
      expect(value.length).toBeGreaterThan(0);
      expect(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)).toBe(false);
      void key;
    }
  });

  test("every {placeholder} in a key appears in its translation", () => {
    const holders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");
    for (const [key, value] of Object.entries(EN)) {
      for (const name of holders(key)) {
        expect(holders(value), `key "${key}" lost {${name}}`).toContain(name);
      }
    }
  });
});
