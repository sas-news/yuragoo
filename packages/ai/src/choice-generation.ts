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
    // /no_think suppresses Qwen3's reasoning trace: the think block eats
    // the token budget, delays the answer and can truncate the JSON.
    "/no_think",
    "あなたはパーティーゲーム「ゆらぐー！」の選択肢ジェネレーターです。",
    "プレイヤーはシナリオの状況に置かれた当事者です。それぞれが「自分ならこうする」と選ぶ、具体的な行動の選択肢を考えてください。",
    "",
    "条件:",
    "- すべての選択肢がそのシナリオ固有の状況への行動であること（「逃げる」「大声を出す」のような、どのシナリオでも使える汎用的な行動は禁止）",
    "- それぞれが違うアプローチであること（例: 正面から挑む / こっそり仕掛ける / 観察する / 誰かに委ねる / ルールを使う / ふざける）",
    "- 明らかな正解や明らかな不正解を作らない",
    "- シナリオの登場物・場所・目的を行動の中に織り込む",
    "  例:「最後のプリンを争う」なら「レジ袋の底にこっそり忍ばせる」「棚の前をふさぎ続ける」のように、そのシナリオでしかできない行動にする",
    "- 少し変な選択肢があってもよい",
    `- 短い（各${CHOICE_LABEL_MAX_GRAPHEMES}文字以内）`,
    "- 出力は必ず日本語で（英語や他言語は不可）",
    "",
    '出力はJSONのみで返してください: {"choices": ["選択肢1", "選択肢2", ...]}',
    "",
    `シナリオ: ${scenario}`,
    `上のシナリオに沿った選択肢をちょうど${memberCount}個、{"choices": [...]}で返してください。`,
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

// Slice the first JSON region out of a chatty response: ```json fences,
// leading prose, or a trailing explanation all drop away.
const jsonSlice = (raw: string): string => {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.search(/[[{]/);
  if (start < 0) return text;
  const close = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
};

// Envelope keys models reach for when the schema asks for {choices}:
// binding wraps ({response}), alternate containers ({result}/{data}),
// and near-synonym keys ({options}/{items} and friends).
const CARRIER_KEYS = [
  "choices",
  "response",
  "result",
  "data",
  "output",
  "content",
  "text",
  "items",
  "options",
  "candidates",
  "answer",
];

// Field names models put labels under when entries arrive as objects.
const ENTRY_KEYS = ["label", "text", "name", "choice", "title", "value"];

const LINE_ITEM = /^\s*(?:[-*・•]|\d+\s*[.、:：）)]|[（(]\s*\d+\s*[)）])\s*/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const UNPARSEABLE = Symbol("unparseable");

const tryParse = (raw: string): unknown => {
  for (const candidate of [raw, jsonSlice(raw)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to the sliced candidate, then give up
    }
  }
  return UNPARSEABLE;
};

// Text that never parses as JSON is treated as a plain list: one entry
// per line, or separated by 、/，/,. Bullets and numbering are stripped.
const textList = (raw: string): string[] => {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(LINE_ITEM, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return text
    .split(/[、,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
};

// Pull the payload out of a record: a carrier key first, then a lone
// array-valued key ({"候補": [...]}), then a dict whose values are all
// strings ({"choices": {"1": "...", ...}} peeled one level earlier).
const descend = (o: Record<string, unknown>): unknown => {
  for (const key of CARRIER_KEYS) if (o[key] !== undefined) return o[key];
  const values = Object.values(o);
  const arrays = values.filter((v) => Array.isArray(v));
  if (arrays.length === 1) return arrays[0];
  if (values.length > 0 && values.every((v) => typeof v === "string")) return values;
  return undefined;
};

// Qwen sometimes returns {label: "..."} objects despite the schema asking
// for bare strings — unwrap them rather than failing the whole batch.
const labelField = (item: unknown): unknown => {
  if (!isRecord(item)) return item;
  for (const key of ENTRY_KEYS) {
    if (typeof item[key] === "string") return item[key];
  }
  return Object.values(item).find((v): v is string => typeof v === "string");
};

// raw is the provider's response payload. Normalization peels envelopes
// (carrier keys, stringify levels, fences/prose, plain-text lists) up to
// a few layers deep, then the contract applies: an array of exactly
// `count` distinct short labels (over-production truncates; under fails).
export const parseChoiceLabels = (raw: unknown, count: number): string[] => {
  let value: unknown = raw;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof value === "string") {
      const parsed = tryParse(value);
      value = parsed === UNPARSEABLE ? textList(value) : parsed;
      continue;
    }
    if (isRecord(value)) {
      const next = descend(value);
      if (next === undefined) break;
      value = next;
      continue;
    }
    break;
  }
  if (!Array.isArray(value)) throw invalid("response was not an array");
  let list: unknown[] = value;
  if (list.length > count) list = list.slice(0, count);
  if (list.length !== count) {
    throw invalid(`expected exactly ${count} choices, got ${list.length}`);
  }
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of list.map(labelField)) {
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
