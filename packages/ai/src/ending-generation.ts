// Ending-caption generation contract (Task 31): the post-game one-shot.
// The model sees ONLY the structured panel set — scenario text, an
// outcome summary (the winner's choice LABEL arrives pre-resolved and
// read-only) and each panel's kind/eventId/verbatim quotes. The full
// post log never leaves the room (story contract), so this input never
// references posts the panels did not cite. The reply is one story
// title (<=40 graphemes) plus one caption per panel (<=80 graphemes,
// keyed by the eventId allowlist the caller supplies).
import {
  countGraphemes,
  type EndingStory,
  ROOM_LANGUAGE_DEFAULT,
  type RoomLanguage,
  STORY_CAPTION_MAX_GRAPHEMES,
  STORY_TITLE_MAX_GRAPHEMES,
  type StoryPanelKind,
} from "@yuragoo/protocol";
import { GenerationProviderError } from "./generative-provider";

// One panel's facts as the model sees them. postIds stay out: row
// identifiers are meaningless to the model and only tempt it to cite
// them — the quotes are the facts it may paraphrase.
export interface EndingPanelInput {
  readonly kind: StoryPanelKind;
  readonly eventId: number;
  readonly quotes: readonly { readonly postId: string; readonly text: string }[];
}

// The outcome summary handed to the model. winnerLabel is resolved
// server-side (committed choice at the winning roster slot) BEFORE the
// call — the model may quote it verbatim but can never change who won
// or what they chose.
export interface EndingOutcomeSummary {
  readonly kind: EndingStory["outcome"]["kind"];
  readonly winnerLabel: string | null; // only for kind === "winner"
  readonly noContestReason: string | null; // only for kind === "noContest"
}

export interface EndingGenerationInput {
  readonly scenario: string;
  readonly outcome: EndingOutcomeSummary;
  readonly panels: readonly EndingPanelInput[];
  // Room language — the model writes the whole story in it. Absent
  // (older callers/tests) means "ja".
  readonly language?: RoomLanguage;
}

export const buildEndingPrompt = (input: EndingGenerationInput): string => {
  if ((input.language ?? ROOM_LANGUAGE_DEFAULT) === "en") {
    return [
      'You are the kamishibai (picture-story) writer for the party game "Yuragoo!".',
      "Read the match record (scenario, outcome, per-page quotes) and write a story title plus one caption per page.",
      "",
      `Input: ${JSON.stringify(input)}`,
      "",
      "Rules:",
      `- One story title (within ${STORY_TITLE_MAX_GRAPHEMES} characters)`,
      `- One caption per page (each within ${STORY_CAPTION_MAX_GRAPHEMES} characters)`,
      "- Write only facts present in the input — never invent facts, names or winners",
      "- Quote the winner's choice label verbatim, unchanged",
      "- Use gentle, simple storybook English",
      'Reply with JSON only: {"title": "...", "panels": [{"eventId": <the page\'s eventId>, "caption": "..."}]}',
    ].join("\n");
  }
  return [
    "あなたはパーティーゲーム「ゆらぐー！」の紙芝居ライターです。",
    "対戦の記録（シナリオ・結果・各ページの引用）を読み、物語のタイトルと各ページのキャプションを書いてください。",
    "",
    `入力: ${JSON.stringify(input)}`,
    "",
    "条件:",
    `- 物語のタイトルを1つ（${STORY_TITLE_MAX_GRAPHEMES}文字以内）`,
    `- 各ページにキャプションを1つずつ（各${STORY_CAPTION_MAX_GRAPHEMES}文字以内）`,
    "- 入力にある事実だけを書く — 新しい事実・名前・勝者を作らない",
    "- 勝者の選択肢ラベルは入力の値をそのまま使う",
    "- ひらがな中心のやわらかい日本語で",
    '出力はJSONのみ: {"title": "...", "panels": [{"eventId": <ページのeventId>, "caption": "..."}]}',
  ].join("\n");
};

// Structured-output schema: panel entries carry the SAME eventIds the
// input lists (enum), so a schema-faithful reply can never invent pages.
export const endingJsonSchema = (eventIds: readonly number[]): Record<string, unknown> => ({
  type: "object",
  properties: {
    title: { type: "string", maxLength: STORY_TITLE_MAX_GRAPHEMES },
    panels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          eventId: { type: "integer", enum: [...eventIds] },
          caption: { type: "string", maxLength: STORY_CAPTION_MAX_GRAPHEMES },
        },
        required: ["eventId", "caption"],
        additionalProperties: false,
      },
      minItems: eventIds.length,
      maxItems: eventIds.length,
    },
  },
  required: ["title", "panels"],
  additionalProperties: false,
});

export interface ParsedEndingCaptions {
  readonly title: string;
  readonly captions: ReadonlyMap<number, string>;
}

const invalid = (message: string): GenerationProviderError =>
  new GenerationProviderError("invalid-response", message);

// Boundary parse for the model's answer. Raw may be a parsed object or
// a JSON string (providers unwrap `response` for either). Entries citing
// an unknown or duplicate eventId, non-string text and per-field cap
// violations are DROPPED — then coverage is enforced all-or-nothing:
// success requires a valid title AND a caption for EVERY allowed
// eventId. Partial coverage rejects the whole result: a half-template,
// half-generated story reads like two authors fighting, so the caller
// keeps the coherent template set instead.
export const parseEndingCaptions = (
  raw: unknown,
  allowedEventIds: readonly number[],
): ParsedEndingCaptions => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw invalid("response was not JSON");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("response was not an object");
  }
  const titleRaw = (value as { title?: unknown }).title;
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  if (title === "" || countGraphemes(title) > STORY_TITLE_MAX_GRAPHEMES) {
    throw invalid("the title was missing or too long");
  }
  const panelsRaw = (value as { panels?: unknown }).panels;
  if (!Array.isArray(panelsRaw)) throw invalid("panels was not an array");
  const allowed = new Set(allowedEventIds);
  const captions = new Map<number, string>();
  for (const entry of panelsRaw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { eventId?: unknown; caption?: unknown };
    if (typeof e.eventId !== "number" || !allowed.has(e.eventId)) continue;
    if (captions.has(e.eventId)) continue; // first entry wins; repeats are dropped
    if (typeof e.caption !== "string") continue;
    const caption = e.caption.trim();
    if (caption === "" || countGraphemes(caption) > STORY_CAPTION_MAX_GRAPHEMES) continue;
    captions.set(e.eventId, caption);
  }
  for (const eventId of allowedEventIds) {
    if (!captions.has(eventId)) throw invalid(`missing caption for eventId ${eventId}`);
  }
  return { title, captions };
};
