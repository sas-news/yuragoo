import {
  DecisionContractError,
  type DecisionDistribution,
  type DecisionResult,
  type DecisionState,
  type MoodId,
  parseDecisionState,
} from "@yuragoo/protocol";
import type { DecisionProvider } from "./provider";

export interface MockDecisionFixture {
  readonly key: string;
  readonly weights: Readonly<Record<string, number>>;
}

export interface MockDecisionProviderOptions {
  readonly seed: number;
  readonly fixtures: readonly MockDecisionFixture[];
  readonly model?: "jev-1.13.0";
}

const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = Math.imul(s ^ (s >>> 15), s | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
};

// Pure PRNG seed mixing seed + revision (both 32-bit halves) + fixture key so
// the same request always yields the same jitter, independent of call order.
const deriveSeed = (seed: number, revision: number, key: string): number => {
  let h = seed >>> 0;
  h = Math.imul(h ^ (revision >>> 0), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ Math.floor(revision / 4294967296), 0x85ebca6b) >>> 0;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 0xc2b2ae35) >>> 0;
  return h >>> 0;
};

const invalid = (message: string): DecisionContractError =>
  new DecisionContractError("invalid-state", message);

export class MockDecisionProvider implements DecisionProvider {
  private readonly seed: number;
  private readonly model: "jev-1.13.0";
  private readonly fixtures: ReadonlyMap<string, Readonly<Record<string, number>>>;

  constructor(options: MockDecisionProviderOptions) {
    if (!Number.isInteger(options.seed)) {
      throw new RangeError("mock provider seed must be a finite integer");
    }
    if (options.model !== undefined && options.model !== "jev-1.13.0") {
      throw new Error("mock provider only supports the jev-1.13.0 model");
    }
    if (options.fixtures.length === 0) {
      throw new Error("mock provider requires at least one fixture");
    }
    const fixtures = new Map<string, Readonly<Record<string, number>>>();
    for (const fixture of options.fixtures) {
      if (fixture.key !== fixture.key.trim() || fixture.key.length === 0) {
        throw new Error("fixture keys must be trimmed and nonempty");
      }
      if (fixtures.has(fixture.key)) {
        throw new Error(`duplicate fixture key: ${fixture.key}`);
      }
      for (const value of Object.values(fixture.weights)) {
        if (!Number.isFinite(value) || value < 0) {
          throw new RangeError("fixture weights must be finite numbers >= 0");
        }
      }
      fixtures.set(fixture.key, fixture.weights);
    }
    this.seed = options.seed;
    this.model = options.model ?? "jev-1.13.0";
    this.fixtures = fixtures;
  }

  async evaluate(state: DecisionState, signal?: AbortSignal): Promise<DecisionResult> {
    signal?.throwIfAborted();
    const valid = parseDecisionState(state);
    const key = valid.mockScenarioKey;
    if (key === undefined) {
      throw invalid("mock provider requires state.mockScenarioKey");
    }
    const weights = this.fixtures.get(key);
    if (weights === undefined) {
      throw invalid("unknown mock scenario key");
    }
    if (Object.keys(weights).length !== valid.choices.length) {
      throw invalid("fixture weights do not match the current choices");
    }
    const raw: number[] = [];
    for (const choice of valid.choices) {
      const weight = weights[choice.id];
      if (weight === undefined) {
        throw invalid("fixture weights do not match the current choices");
      }
      raw.push(weight);
    }
    signal?.throwIfAborted();
    const count = raw.length;
    const maxWeight = Math.max(...raw);
    // Overflow-safe: normalize by the max first, then apply +-0.5% seeded
    // jitter and renormalize; a zero total stays exactly uniform.
    const random = mulberry32(deriveSeed(this.seed, valid.revision, key));
    const scaled =
      maxWeight === 0
        ? raw.map(() => 1)
        : raw.map((w) => (w / maxWeight) * (1 + (random() * 2 - 1) * 0.005));
    const sum = scaled.reduce((acc, w) => acc + w, 0);
    const distribution: DecisionDistribution[] = valid.choices.map((choice, i) => ({
      choiceId: choice.id,
      probability: (scaled[i] ?? 0) / sum,
    }));
    let selectedIndex = 0;
    for (let i = 1; i < count; i += 1) {
      const current = distribution[i];
      const best = distribution[selectedIndex];
      if (current && best && current.probability > best.probability) selectedIndex = i;
    }
    const selected = distribution[selectedIndex];
    if (selected === undefined) throw invalid("no selectable choice");
    const confidence = Math.max(
      0,
      Math.min(1, (selected.probability - 1 / count) / (1 - 1 / count)),
    );
    // Mock mood: derived from the fixture's own pull so /play and local dev
    // show the same face range a live Jev verdict would — a dominant pull
    // adheres, a clear one engages, a flat one deliberates. No idle clock
    // here, so "bored" never fires (it needs a real room's staleness).
    const top = selected.probability;
    const mood: MoodId = top >= 0.78 ? "adhering" : top >= 0.5 ? "engaged" : "hesitating";
    return {
      revision: valid.revision,
      model: this.model,
      selectedChoiceId: selected.choiceId,
      confidence,
      distribution,
      mood,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
