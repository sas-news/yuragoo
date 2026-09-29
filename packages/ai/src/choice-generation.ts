// Choice-generation prompt + answer validation (Task 25). The prompt
// encodes the S:20 quality bar (各候補が十分異なる/明らかな正解なし/役割
// 被りなし/シナリオから理解できる/少し変でよい/短い); parseChoiceLabels
// is the client-visible safety net — exactly `count` labels, each
// non-empty and <=40 graphemes after trim, pairwise distinct under the
// same NFKC+trim key the start gate uses. Anything less rejects: a
// failed parse consumed the attempt like any upstream failure.
import { CHOICE_LABEL_MAX_GRAPHEMES, countGraphemes, labelKey } from "@yuragoo/protocol";
import { GenerationProviderError } from "./generative-provider";

export const buildChoicePrompt = (scenario: string, memberCount: number): string =>
  [
    "あなたはパーティーゲーム「ゆらぐー！」の選択肢ジェネレーターです。",
    "シナリオを読み、プレイヤーがそれぞれ1つずつ選ぶ行動の選択肢を考えてください。",
    "",
    `シナリオ: ${scenario}`,
    `人数: ${memberCount}人`,
    "",
    `ちょうど${memberCount}個の選択肢を作ってください。`,
    "条件:",
    "- 各候補が十分に異なる",
    "- 明らかな正解を作らない",
    "- 役割が被らない",
    "- シナリオからある程度理解できる",
    "- 少し変な選択肢があってもよい",
    `- 短い（各${CHOICE_LABEL_MAX_GRAPHEMES}文字以内）`,
    "- 出力は必ず日本語で（英語や他言語は不可）",
    '出力はJSONのみで返してください: {"choices": ["選択肢1", "選択肢2", ...]}',
    '出力例: {"choices": ["こっそり入れ替える", "大声で歌いながら運ぶ", "その場で寝る"]}',
  ].join("\n");

// Structured-output schema: exactly `count` distinct short labels.
export const choiceLabelsJsonSchema = (count: number): Record<string, unknown> => ({
  type: "object",
  properties: {
    choices: {
      type: "array",
      items: { type: "string", maxLength: CHOICE_LABEL_MAX_GRAPHEMES },
      minItems: count,
      maxItems: count,
    },
  },
  required: ["choices"],
  additionalProperties: false,
});

const invalid = (message: string): GenerationProviderError =>
  new GenerationProviderError("invalid-response", message);

// raw is the provider's response payload: an object with `choices` (the
// schema shape), a bare array, or a JSON string of either.
export const parseChoiceLabels = (raw: unknown, count: number): string[] => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw invalid("response was not JSON");
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    value = (value as { choices?: unknown }).choices;
  }
  if (!Array.isArray(value) || value.length !== count) {
    throw invalid(`expected exactly ${count} choices`);
  }
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw invalid("a choice was not a string");
    const label = item.trim();
    if (label === "") throw invalid("a choice was empty");
    if (countGraphemes(label) > CHOICE_LABEL_MAX_GRAPHEMES) {
      throw invalid(`a choice exceeded ${CHOICE_LABEL_MAX_GRAPHEMES} graphemes`);
    }
    const key = labelKey(label);
    if (seen.has(key)) throw invalid("choices were not distinct");
    seen.add(key);
    labels.push(label);
  }
  return labels;
};
