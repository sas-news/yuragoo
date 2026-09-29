// Scenario (お題) generation prompt + answer validation (Task 44). Same
// GenerativeProvider seam as choice generation — one prompt, one JSON
// schema — but the output is a single scenario line. The quality bar
// mirrors the built-in presets: one glance, open-ended, no obvious answer.
import { countGraphemes } from "@yuragoo/protocol";
import { GenerationProviderError } from "./generative-provider";

// Generated scenarios cap far below the lobby field's 1000-grapheme edit
// limit: the built-in presets run ~30–60, and a one-line お題 is what the
// game plays best. The model is asked for it AND the parser enforces it.
export const GENERATED_SCENARIO_MAX_GRAPHEMES = 160;

export const buildScenarioPrompt = (memberCount: number): string =>
  [
    "あなたはパーティーゲーム「ゆらぐー！」のお題ジェネレーターです。",
    "プレイヤーがそれぞれ一言で「引っ張る」方向を決めるお題をひとつ考えてください。",
    "",
    `人数: ${memberCount}人`,
    "",
    "条件:",
    "- 出力は必ず日本語で（英語や他言語は不可）",
    "- 状況と問いかけがひとめで分かる一行",
    "- 明らかな正解を作らない",
    "- プレイヤーごとに違う答えが出せる",
    "- 少し変な切り口でもよい",
    "- 日常と非日常の間くらいの題材",
    `- 短い（${GENERATED_SCENARIO_MAX_GRAPHEMES}文字以内）`,
    "例: 無人島に流れ着いた一行。あしたの朝、まず何をするか",
    '出力はJSONのみで返してください: {"scenario": "お題文"}',
  ].join("\n");

// Structured-output schema: exactly one scenario string.
export const scenarioJsonSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: {
    scenario: { type: "string", maxLength: GENERATED_SCENARIO_MAX_GRAPHEMES },
  },
  required: ["scenario"],
  additionalProperties: false,
});

const invalid = (message: string): GenerationProviderError =>
  new GenerationProviderError("invalid-response", message);

// raw is the provider's response payload: an object with `scenario` (the
// schema shape), a bare string, or a JSON string of either. Multi-line
// output collapses to one line before the grapheme cap is measured.
export const parseScenarioText = (raw: unknown): string => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // A bare non-JSON string is itself the scenario.
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    value = (value as { scenario?: unknown }).scenario;
  }
  if (typeof value !== "string") throw invalid("response had no scenario string");
  const scenario = value.replace(/\s*\n\s*/g, " ").trim();
  if (scenario === "") throw invalid("scenario was empty");
  const graphemes = countGraphemes(scenario);
  if (graphemes > GENERATED_SCENARIO_MAX_GRAPHEMES) {
    throw invalid(`scenario exceeded ${GENERATED_SCENARIO_MAX_GRAPHEMES} graphemes`);
  }
  return scenario;
};
