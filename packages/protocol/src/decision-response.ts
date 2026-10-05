// JEV response-side contract (split from decision.ts at the loc limit):
// the strict envelope schema, the lenient mood extraction and the
// distribution validation — probability keys must exactly cover the
// requested choice ids, sum to 1, and the argmax must be the selected id.
import { z } from "zod";
import type { DecisionDistribution, DecisionEnvelope, DecisionResult } from "./decision";
import { jevModelSchema, type MoodId, MOOD_IDS, moodIdSchema } from "./decision-shared";
import { DecisionContractError } from "./errors";
import { choiceIdSchema } from "./ids";

const tokenCountSchema = z.number().int().min(0);
const choiceAnswerSchema = z.strictObject({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const jevResponseSchema = z.strictObject({
  model: jevModelSchema,
  answers: z.strictObject({
    attraction: choiceAnswerSchema,
    // Mood is cosmetic: `unknown` keeps the envelope strict without letting
    // a malformed mood answer void the attraction verdict it rode in on.
    mood: z.unknown().optional(),
  }),
  usage: z.strictObject({
    input_tokens: tokenCountSchema,
    output_tokens: tokenCountSchema,
  }),
});

// Lenient mood extraction: only a well-formed answer (exact MOOD_IDS key
// set, unit sum) yields a verdict — the argmax of its probabilities. Any
// deviation degrades to "no mood", never to a contract rejection.
const parseMoodAnswer = (input: unknown): MoodId | undefined => {
  const parsed = choiceAnswerSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const expected = new Set<string>(MOOD_IDS);
  const entries = Object.entries(parsed.data.probabilities);
  if (entries.length !== expected.size || entries.some(([k]) => !expected.has(k))) {
    return undefined;
  }
  const sum = entries.reduce((acc, [, p]) => acc + p, 0);
  if (Math.abs(sum - 1) > 1e-3) return undefined;
  let best: MoodId | undefined;
  for (const [id, p] of entries) {
    if (best === undefined || p > (parsed.data.probabilities[best] ?? 0)) {
      best = moodIdSchema.parse(id);
    }
  }
  return best;
};

const invalidResponse = (message: string): DecisionContractError =>
  new DecisionContractError("invalid-response", message);

export const parseJevDecisionResponse = (
  input: unknown,
  envelope: DecisionEnvelope,
): DecisionResult => {
  const parsed = jevResponseSchema.safeParse(input);
  if (!parsed.success) throw invalidResponse("JEV response failed schema validation");
  const answer = parsed.data.answers.attraction;
  const expectedIds = Object.keys(envelope.body.questions.attraction.criteria);
  const expected = new Set(expectedIds);
  const entries = Object.entries(answer.probabilities);
  if (entries.length !== expectedIds.length || entries.some(([key]) => !expected.has(key))) {
    throw invalidResponse("probability keys do not match the requested choices");
  }
  const probabilities = new Map(entries);
  const selected = choiceIdSchema.safeParse(answer.choice);
  if (!selected.success || !expected.has(selected.data)) {
    throw invalidResponse("selected choice is not a requested choice");
  }
  const sum = entries.reduce((acc, [, p]) => acc + p, 0);
  if (Math.abs(sum - 1) > 1e-6) throw invalidResponse("probabilities do not sum to 1");
  const maxProbability = Math.max(...entries.map(([, p]) => p));
  if (probabilities.get(selected.data) !== maxProbability) {
    throw invalidResponse("selected choice is not a maximum-probability choice");
  }
  const distribution: DecisionDistribution[] = [];
  for (const id of expectedIds) {
    const raw = probabilities.get(id);
    if (raw === undefined) throw invalidResponse("missing probability for a requested choice");
    distribution.push({ choiceId: choiceIdSchema.parse(id), probability: raw / sum });
  }
  const mood = parseMoodAnswer(parsed.data.answers.mood);
  return {
    revision: envelope.revision,
    model: "jev-1.13.0",
    selectedChoiceId: selected.data,
    confidence: answer.confidence,
    distribution,
    ...(mood === undefined ? {} : { mood }),
    usage: {
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
    },
  };
};
