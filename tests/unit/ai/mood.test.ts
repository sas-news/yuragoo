import { expect, test } from "bun:test";
import { MockDecisionProvider } from "@yuragoo/ai";
import {
  createDecisionEnvelope,
  createJevRequestBody,
  type DecisionState,
  parseDecisionState,
  parseJevDecisionResponse,
} from "@yuragoo/protocol";

// The Jev request carries a second "mood" question alongside attraction:
// the same model picks the creature's feeling from five fixed ids, and the
// verdict lands on DecisionResult.mood. Malformed or absent moods degrade
// to "no mood" — they never kill the attraction verdict (Task 43).

const stateFor = (mockScenarioKey?: string): DecisionState =>
  parseDecisionState({
    revision: 7,
    scenario: "雨の日の散歩",
    persona: "穏やかな観察者",
    activeContext: ["朝"],
    choices: [
      { id: "a", label: "選択a" },
      { id: "b", label: "選択b" },
    ],
    ...(mockScenarioKey === undefined ? {} : { mockScenarioKey }),
  });

const wireResponse = (mood: unknown) => ({
  model: "jev-1.13.0",
  answers: {
    attraction: {
      type: "choice",
      choice: "a",
      confidence: 0.5,
      probabilities: { a: 0.7, b: 0.3 },
    },
    mood,
  },
  usage: { input_tokens: 12, output_tokens: 7 },
});

const parseMood = (mood: unknown) =>
  parseJevDecisionResponse(wireResponse(mood), createDecisionEnvelope(stateFor(), 1));

test("the request body asks the mood question with the five mood ids as criteria", () => {
  const body = createJevRequestBody(stateFor());
  expect(Object.keys(body.questions).sort()).toEqual(["attraction", "mood"]);
  expect(body.questions.mood.type).toBe("choice");
  expect(Object.keys(body.questions.mood.criteria).sort()).toEqual([
    "adhering",
    "bored",
    "engaged",
    "hesitating",
    "rest",
  ]);
});

test("a well-formed mood answer lands on the result", () => {
  const mood = {
    type: "choice",
    choice: "bored",
    confidence: 0.9,
    probabilities: { rest: 0.05, hesitating: 0.05, engaged: 0.8, bored: 0.02, adhering: 0.08 },
  };
  // The numbers are the verdict — the `choice` field is ignored, argmax wins.
  expect(parseMood(mood).mood).toBe("engaged");
});

test("absent or malformed moods degrade to undefined, never kill the verdict", () => {
  // Omitted entirely — older upstreams and mocks simply don't answer it.
  expect(parseMood(undefined).mood).toBeUndefined();
  const { mood: _mood, ...answers } = wireResponse(undefined).answers;
  const res = { ...wireResponse(undefined), answers };
  expect(parseJevDecisionResponse(res, createDecisionEnvelope(stateFor(), 1)).mood).toBeUndefined();
  expect(parseMood({ nope: true }).mood).toBeUndefined();
  // Unknown criterion id — the mood must cover exactly the five ids.
  expect(
    parseMood({
      type: "choice",
      choice: "engaged",
      confidence: 0.5,
      probabilities: { rest: 0.5, hesitating: 0.5, engaged: 0, bored: 0, sparkly: 0 },
    }).mood,
  ).toBeUndefined();
  // Probabilities off unit sum are likewise rejected.
  expect(
    parseMood({
      type: "choice",
      choice: "engaged",
      confidence: 0.5,
      probabilities: { rest: 0.6, hesitating: 0.6, engaged: 0.6, bored: 0.6, adhering: 0.6 },
    }).mood,
  ).toBeUndefined();
});

test("the mock provider emits a mood derived from its own pull", async () => {
  const provider = new MockDecisionProvider({
    seed: 1234,
    fixtures: [{ key: "duo", weights: { a: 0.6, b: 0.4 } }],
  });
  // The "duo" fixture lands near 0.6 — a clear, not dominant, pull.
  expect((await provider.evaluate(stateFor("duo"))).mood).toBe("engaged");
  // Deterministic: the same state always wears the same face.
  expect((await provider.evaluate(stateFor("duo"))).mood).toBe("engaged");
});
