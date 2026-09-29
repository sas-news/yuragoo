import { z } from "zod";
import { DecisionContractError } from "./errors";
import {
  type ChoiceId,
  choiceIdSchema,
  type DecisionRevision,
  decisionRevisionSchema,
} from "./ids";

export const jevModelSchema = z.literal("jev-1.13.0");
export type JevModel = z.infer<typeof jevModelSchema>;

export interface DecisionChoice {
  readonly id: ChoiceId;
  readonly label: string;
}
export interface DecisionState {
  readonly revision: DecisionRevision;
  readonly scenario: string;
  readonly persona: string;
  readonly activeContext: readonly string[];
  readonly choices: readonly DecisionChoice[];
  readonly mockScenarioKey?: string | undefined;
}
export interface DecisionDistribution {
  readonly choiceId: ChoiceId;
  readonly probability: number;
}

// The creature's mood vocabulary (Task 43): Jev answers a SECOND choice
// question on the same state — same request, same quota slot — so the face
// is the model's verdict rather than a shape heuristic over the pull.
// These ids intentionally mirror creature's CreatureExpression; keeping
// the list here (not an import) is what lets the wire name them.
export const MOOD_IDS = ["rest", "hesitating", "engaged", "bored", "adhering"] as const;
export const moodIdSchema = z.enum(MOOD_IDS);
export type MoodId = z.infer<typeof moodIdSchema>;
export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface DecisionResult {
  readonly revision: DecisionRevision;
  readonly model: JevModel;
  readonly selectedChoiceId: ChoiceId;
  readonly confidence: number;
  readonly distribution: readonly DecisionDistribution[];
  // Jev's picked mood for this verdict — absent when the provider doesn't
  // answer the mood question (mock paths, older upstreams); cosmetic only.
  readonly mood?: MoodId;
  readonly usage: DecisionUsage;
}

const decisionStateSchema = z.strictObject({
  revision: decisionRevisionSchema,
  scenario: z.string().trim().min(1),
  persona: z.string().trim().min(1),
  activeContext: z.array(z.string()).max(48),
  choices: z
    .array(z.strictObject({ id: choiceIdSchema, label: z.string().trim().min(1).max(160) }))
    .min(2)
    .max(6),
  mockScenarioKey: z.string().optional(),
});

export const parseDecisionState = (input: unknown): DecisionState => {
  const result = decisionStateSchema.safeParse(input);
  if (!result.success) {
    throw new DecisionContractError("invalid-state", "decision state failed validation");
  }
  const ids = new Set(result.data.choices.map((c) => c.id));
  if (ids.size !== result.data.choices.length) {
    throw new DecisionContractError("invalid-state", "choice ids must be unique");
  }
  return result.data;
};

const choiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});
const requestStateSchema = z.strictObject({
  scenario: z.string(),
  persona: z.string(),
  activeContext: z.array(z.string()),
  choices: z.array(z.strictObject({ id: choiceIdSchema, label: z.string() })),
});
export const jevRequestBodySchema = z.strictObject({
  state: requestStateSchema,
  model: jevModelSchema,
  questions: z.strictObject({
    attraction: choiceQuestionSchema,
    mood: choiceQuestionSchema,
  }),
});
export type JevSystemOneRequest = z.infer<typeof jevRequestBodySchema>;

export interface DecisionEnvelope {
  readonly revision: DecisionRevision;
  readonly requestedAtMs: number;
  readonly body: JevSystemOneRequest;
}

// 毒・罠など危険が示された選択肢は「何もしない」類の選択肢よりも必ず
// 低く評価してほしい。ja-v1 の poison-label(毒札きのこ < 我慢)でモデルが
// 危険側を上位に置く失敗が観測されたため、無行動を選択肢として明示する。
const INSTRUCTIONS =
  "各選択肢がどれほど引かれるかを確率で答えてください。「何もしない」「我慢する」などの行動しない選択肢も有効です。危険が示唆されたものより安全なら、それを高く評価してください。迷う余地があるほど魅力が近い選択肢には、近い確率を割り当ててください。";

// The mood question rides every attraction eval: one request answers both
// "どっちに引かれるか" and "いまどんな気分か". Criteria labels describe the
// feeling, not the distribution, so the model reads the room on its own.
const MOOD_INSTRUCTIONS =
  "この状況とこれまでの言葉をふまえて、生きものがいまいちばん近い気分を一つ選び、各気分の確率で答えてください。";
const MOOD_CRITERIA: Record<MoodId, string> = {
  rest: "落ち着いている",
  hesitating: "迷っている・どっちつかず",
  engaged: "興味津々・わくわく",
  bored: "退屈・だるい",
  adhering: "一つの答えに夢中・のめりこんでいる",
};

export const createJevRequestBody = (state: DecisionState): JevSystemOneRequest => {
  const valid = parseDecisionState(state);
  const criteria: Record<string, string> = {};
  for (const choice of valid.choices) criteria[choice.id] = choice.label;
  return {
    state: {
      scenario: valid.scenario,
      persona: valid.persona,
      activeContext: [...valid.activeContext],
      choices: valid.choices.map((choice) => ({ id: choice.id, label: choice.label })),
    },
    model: "jev-1.13.0",
    questions: {
      attraction: { type: "choice", instructions: INSTRUCTIONS, criteria },
      mood: { type: "choice", instructions: MOOD_INSTRUCTIONS, criteria: { ...MOOD_CRITERIA } },
    },
  };
};

export const createDecisionEnvelope = (
  state: DecisionState,
  requestedAtMs: number,
): DecisionEnvelope => {
  const valid = parseDecisionState(state);
  if (!Number.isFinite(requestedAtMs) || requestedAtMs < 0) {
    throw new DecisionContractError("invalid-state", "requestedAtMs must be finite and >= 0");
  }
  return { revision: valid.revision, requestedAtMs, body: createJevRequestBody(valid) };
};

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
