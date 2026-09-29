import { expect, test } from "bun:test";
import { MockDecisionProvider } from "@yuragoo/ai";
import {
  createDecisionEnvelope,
  createJevRequestBody,
  DecisionContractError,
  type DecisionContractErrorKind,
  type DecisionState,
  parseDecisionState,
  parseJevDecisionResponse,
} from "@yuragoo/protocol";
const IDS = ["a", "b", "c", "d", "e", "f"] as const;
const PROBS: Readonly<Record<number, readonly number[]>> = {
  2: [0.7, 0.3],
  4: [0.55, 0.2, 0.15, 0.1],
  6: [0.4, 0.2, 0.15, 0.1, 0.1, 0.05],
};
const rawState = (choices: readonly { id: string; label: string }[]) => ({
  revision: 1,
  scenario: "s",
  persona: "p",
  activeContext: [],
  choices,
});
const stateFor = (n: number, mockScenarioKey?: string): DecisionState =>
  parseDecisionState({
    revision: 7,
    scenario: "雨の日の散歩",
    persona: "穏やかな観察者",
    activeContext: ["朝"],
    choices: IDS.slice(0, n).map((id) => ({ id, label: `選択${id}` })),
    ...(mockScenarioKey === undefined ? {} : { mockScenarioKey }),
  });
const envelopeFor = (n = 2) => createDecisionEnvelope(stateFor(n), 1_234);
const wireResponse = (
  probabilities: Readonly<Record<string, number | string>>,
  choice = "a",
  confidence = 0.5,
) => ({
  model: "jev-1.13.0",
  answers: { attraction: { type: "choice", choice, confidence, probabilities } },
  usage: { input_tokens: 12, output_tokens: 7 },
});
const parseResponse = (input: unknown, n = 2) => parseJevDecisionResponse(input, envelopeFor(n));
const mockProvider = () =>
  new MockDecisionProvider({
    seed: 1234,
    fixtures: [
      { key: "duo", weights: { a: 0.6, b: 0.4 } },
      { key: "quad", weights: { a: 0.1, b: 0.7, c: 0.15, d: 0.05 } },
      { key: "hex", weights: { a: 0.3, b: 0.05, c: 0.2, d: 0.1, e: 0.25, f: 0.1 } },
      { key: "zero", weights: { a: 0, b: 0 } },
    ],
  });
const expectContractError = async (
  run: () => unknown,
  kind: DecisionContractErrorKind,
): Promise<void> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof DecisionContractError) {
      expect(error.kind).toBe(kind);
      return;
    }
    throw error;
  }
  throw new Error("expected DecisionContractError");
};
const badResponse = (input: unknown) =>
  expectContractError(() => parseResponse(input), "invalid-response");
const badState = (input: unknown) =>
  expectContractError(() => parseDecisionState(input), "invalid-state");
test("happy: official-shaped responses parse for 2, 4 and 6 choices", () => {
  // Given canonical states with 2, 4 and 6 choices and valid envelopes
  for (const n of [2, 4, 6]) {
    const probs = PROBS[n] ?? [];
    const probabilities = Object.fromEntries(IDS.slice(0, n).map((id, i) => [id, probs[i] ?? 0]));
    // When an official wire response is parsed against the envelope
    const result = parseResponse(wireResponse(probabilities, "a", n === 2 ? 0 : 0.5), n);
    // Then the distribution keeps request order, unit sum and finite [0,1] values
    expect(result.model).toBe("jev-1.13.0");
    expect(Number(result.revision)).toBe(7);
    expect(String(result.selectedChoiceId)).toBe("a");
    expect(result.confidence).toBe(n === 2 ? 0 : 0.5);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.distribution.map((d) => String(d.choiceId))).toEqual(IDS.slice(0, n));
    const sum = result.distribution.reduce((acc, d) => acc + d.probability, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    for (const d of result.distribution) {
      expect(Number.isFinite(d.probability)).toBe(true);
      expect(d.probability).toBeGreaterThanOrEqual(0);
      expect(d.probability).toBeLessThanOrEqual(1);
    }
  }
});
test("happy: envelope metadata never leaks into the wire body", () => {
  // Given a state that carries a revision and a dev-only mock key
  const state = stateFor(4, "quad");
  const envelope = createDecisionEnvelope(state, 9_999);
  const body = createJevRequestBody(state);
  // Then the body holds exactly state/model/questions and criteria map ids to labels
  expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
  expect("revision" in body.state).toBe(false);
  expect("mockScenarioKey" in body.state).toBe(false);
  // The mood question's five criteria are covered in mood.test.ts (Task 43).
  expect(Object.keys(body.questions).sort()).toEqual(["attraction", "mood"]);
  expect(body.questions.attraction.type).toBe("choice");
  const criteria = body.questions.attraction.criteria;
  expect(Object.keys(criteria)).toEqual(["a", "b", "c", "d"]);
  expect(criteria.b).toBe("選択b");
  // And the envelope alone carries revision and timestamp
  expect(Number(envelope.revision)).toBe(7);
  expect(envelope.requestedAtMs).toBe(9_999);
});
test("happy: mock provider evaluates 2, 4 and 6 choice fixtures", async () => {
  // Given fixtures for each supported choice count
  const provider = mockProvider();
  const cases: [number, string, string][] = [
    [2, "duo", "a"],
    [4, "quad", "b"],
    [6, "hex", "a"],
  ];
  for (const [n, key, expected] of cases) {
    // When a matching state is evaluated
    const result = await provider.evaluate(stateFor(n, key));
    // Then the strongest fixture weight wins and the distribution is normalized
    expect(String(result.selectedChoiceId)).toBe(expected);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.distribution.map((d) => String(d.choiceId))).toEqual(IDS.slice(0, n));
    const sum = result.distribution.reduce((acc, d) => acc + d.probability, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const selected = result.distribution.find((d) => d.choiceId === result.selectedChoiceId);
    expect(selected?.probability).toBe(Math.max(...result.distribution.map((d) => d.probability)));
  }
});
test("happy: mock results are deterministic regardless of call order", async () => {
  // Given one provider evaluating B then A and a fresh provider evaluating A
  const stateA = stateFor(4, "quad");
  const provider = mockProvider();
  await provider.evaluate(stateFor(2, "duo"));
  const inSequence = await provider.evaluate(stateA);
  const standalone = await mockProvider().evaluate(stateA);
  // Then identical seed and state produce identical results
  expect(standalone).toEqual(inSequence);
});
test("happy: zero-total fixtures evaluate to a uniform distribution", async () => {
  // Given a fixture whose weights are all zero
  const result = await mockProvider().evaluate(stateFor(2, "zero"));
  // Then every choice receives 1/N and the first choice wins the tie
  expect(result.distribution.map((d) => d.probability)).toEqual([0.5, 0.5]);
  expect(String(result.selectedChoiceId)).toBe("a");
  expect(result.confidence).toBe(0);
});
test("happy: response confidence is metadata and never alters probabilities", () => {
  // Given a response whose confidence disagrees with the selected probability
  const result = parseResponse(wireResponse({ a: 0.9, b: 0.1 }, "a", 0.05));
  // Then probabilities pass through verbatim and confidence is kept as metadata
  expect(result.confidence).toBe(0.05);
  expect(result.distribution.map((d) => d.probability)).toEqual([0.9, 0.1]);
});
test("failure: malformed probability maps are rejected", async () => {
  // Missing key, extra key, string-typed value and a bad sum each fail
  await badResponse(wireResponse({ a: 0.7 }));
  await badResponse(wireResponse({ a: 0.5, b: 0.4, z: 0.1 }));
  await badResponse(wireResponse({ a: "0.7", b: 0.3 }));
  await badResponse(wireResponse({ a: 0.5, b: 0.3 }));
});
test("failure: unknown model, type or selection is rejected", async () => {
  const good = wireResponse({ a: 0.7, b: 0.3 });
  await badResponse({ ...good, model: "jev-9.9.9" });
  // An answer typed "score" instead of "choice" fails the literal check
  const score = { ...good.answers.attraction, type: "score" };
  await badResponse({ ...good, answers: { attraction: score } });
  await badResponse(wireResponse({ a: 0.7, b: 0.3 }, "z"));
  // A selected choice outside the maximum-probability ties also fails
  await badResponse(wireResponse({ a: 0.7, b: 0.3 }, "b"));
});
test("failure: confidence outside 0..1 and extra keys are rejected", async () => {
  const good = wireResponse({ a: 0.7, b: 0.3 });
  await badResponse(wireResponse({ a: 0.7, b: 0.3 }, "a", 1.5));
  await badResponse(wireResponse({ a: 0.7, b: 0.3 }, "a", -0.2));
  // A spoofed revision at the root, an extra field inside the attraction answer
  // and an extra sibling under answers are all strict rejections
  await badResponse({ ...good, revision: 0 });
  const extra = { ...good.answers.attraction, source: "mock" };
  await badResponse({ ...good, answers: { attraction: extra } });
  await badResponse({ ...good, answers: { ...good.answers, impact: good.answers.attraction } });
  // Usage is required: missing, extra-keyed, string and fractional counts fail
  const { usage: _dropped, ...noUsage } = good;
  await badResponse(noUsage);
  await badResponse({ ...good, usage: { input_tokens: 1, output_tokens: 2, cache: 0 } });
  await badResponse({ ...good, usage: { input_tokens: "12", output_tokens: 7 } });
  await badResponse({ ...good, usage: { input_tokens: 1.5, output_tokens: -2 } });
});
test("failure: invalid internal states are rejected", async () => {
  const one = [{ id: "a", label: "x" }];
  const dup = [
    { id: "a", label: "x" },
    { id: "a", label: "y" },
  ];
  const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id, label: "x" }));
  const badId = [
    { id: "Bad-Id", label: "x" },
    { id: "b", label: "y" },
  ];
  // Duplicate ids, counts outside 2..6 and malformed ids each fail
  await badState(rawState(one));
  await badState(rawState(dup));
  await badState(rawState(seven));
  await badState(rawState(badId));
  // And negative, NaN or infinite request timestamps fail
  const state = stateFor(2);
  const env = (ms: number) => createDecisionEnvelope(state, ms);
  await expectContractError(() => env(-1), "invalid-state");
  await expectContractError(() => env(Number.NaN), "invalid-state");
  await expectContractError(() => env(Number.POSITIVE_INFINITY), "invalid-state");
});
test("failure: mock provider rejects bad state, fixture and config", async () => {
  const evalBad = (state: DecisionState) =>
    expectContractError(() => mockProvider().evaluate(state), "invalid-state");
  // Missing key, unknown key and a fixture covering different choice ids
  await evalBad(stateFor(2));
  await evalBad(stateFor(2, "nope"));
  await evalBad(stateFor(2, "quad"));
  // Constructor validates seed, fixture keys/uniqueness, weights and model
  const fixture = { key: "duo", weights: { a: 0.5, b: 0.5 } };
  const neg = { key: "x", weights: { a: -1 } };
  const inf = { key: "x", weights: { a: Number.POSITIVE_INFINITY } };
  const padded = { key: " duo ", weights: { a: 1 } };
  expect(() => new MockDecisionProvider({ seed: 1.5, fixtures: [fixture] })).toThrow();
  expect(() => new MockDecisionProvider({ seed: 0, fixtures: [] })).toThrow();
  expect(() => new MockDecisionProvider({ seed: 0, fixtures: [fixture, fixture] })).toThrow();
  expect(() => new MockDecisionProvider({ seed: 0, fixtures: [padded] })).toThrow();
  expect(() => new MockDecisionProvider({ seed: 0, fixtures: [neg] })).toThrow();
  expect(() => new MockDecisionProvider({ seed: 0, fixtures: [inf] })).toThrow();
  // A runtime-unknown model is rejected even when the type system is bypassed
  const badModel = { seed: 0, fixtures: [fixture], model: "jev-other" };
  expect(() => Reflect.construct(MockDecisionProvider, [badModel])).toThrow();
});
test("failure: an already-aborted signal rejects with AbortError", async () => {
  // Given a signal aborted before evaluation starts, Then evaluation rejects
  await expect(
    mockProvider().evaluate(stateFor(2, "duo"), AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
});
