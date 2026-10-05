import { z } from "zod";
import { DecisionContractError } from "./errors";
import {
  type ChoiceId,
  choiceIdSchema,
  type DecisionRevision,
  decisionRevisionSchema,
} from "./ids";
import { ROOM_LANGUAGE_DEFAULT, type RoomLanguage, roomLanguageSchema } from "./language";

export { jevModelSchema, MOOD_IDS, moodIdSchema } from "./decision-shared";
export type { JevModel, MoodId } from "./decision-shared";
import { jevModelSchema, type JevModel, type MoodId } from "./decision-shared";

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
  // Shared-text language of the room — picks the instructions/criteria
  // language below. Absent (older states, ja-only fixtures) means "ja".
  readonly language?: RoomLanguage | undefined;
}
export interface DecisionDistribution {
  readonly choiceId: ChoiceId;
  readonly probability: number;
}

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
  language: roomLanguageSchema.optional(),
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
// The English text is a faithful carry-over: "do nothing" choices stay
// valid, flagged-danger options rank below safe ones, close calls share
// probability mass.
const INSTRUCTIONS: Record<RoomLanguage, string> = {
  ja: "各選択肢がどれほど引かれるかを確率で答えてください。「何もしない」「我慢する」などの行動しない選択肢も有効です。危険が示唆されたものより安全なら、それを高く評価してください。迷う余地があるほど魅力が近い選択肢には、近い確率を割り当ててください。",
  en: 'Answer with the probability of each choice being picked. Choices that do nothing ("do nothing", "wait it out", …) are valid. If a choice carries any hint of danger or harm, it must always rank below every safe option — give it the smallest probability. The more similar in appeal two choices are, the closer their probabilities should be.',
};

// The mood question rides every attraction eval: one request answers both
// "どっちに引かれるか" and "いまどんな気分か". Criteria labels describe the
// feeling, not the distribution, so the model reads the room on its own.
const MOOD_INSTRUCTIONS: Record<RoomLanguage, string> = {
  ja: "この状況とこれまでの言葉をふまえて、生きものがいまいちばん近い気分を一つ選び、各気分の確率で答えてください。",
  en: "Given the situation and what has been said so far, pick the mood the creature is closest to right now, and give a probability for each mood.",
};
const MOOD_CRITERIA: Record<RoomLanguage, Record<MoodId, string>> = {
  ja: {
    rest: "落ち着いている",
    hesitating: "迷っている・どっちつかず",
    engaged: "興味津々・わくわく",
    bored: "退屈・だるい",
    adhering: "一つの答えに夢中・のめりこんでいる",
  },
  en: {
    rest: "calm and settled",
    hesitating: "torn between options",
    engaged: "curious and excited",
    bored: "bored and listless",
    adhering: "fixated on one answer",
  },
};

export const createJevRequestBody = (state: DecisionState): JevSystemOneRequest => {
  const valid = parseDecisionState(state);
  const lang = valid.language ?? ROOM_LANGUAGE_DEFAULT;
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
      attraction: { type: "choice", instructions: INSTRUCTIONS[lang], criteria },
      mood: {
        type: "choice",
        instructions: MOOD_INSTRUCTIONS[lang],
        criteria: { ...MOOD_CRITERIA[lang] },
      },
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

// Response-side parsing lives in ./decision-response (loc limit) —
// re-exported so import sites stay on "@yuragoo/protocol".
export { parseJevDecisionResponse } from "./decision-response";
