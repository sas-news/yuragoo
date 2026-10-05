// Deterministic story text (Task 29): the template fallback for panel
// titles and captions. Copy may restate facts already on the panel —
// scenario, committed choice labels, the outcome — and never invents
// players, winners or quotes. Every string passes through a grapheme
// clip so schema caps (40 title / 80 caption, Intl.Segmenter) hold even
// when a long scenario or label would overflow mid-cluster.
//
// Copy exists per room language: ja keeps the soft hiragana product
// voice, en mirrors it with plain, gentle wording. The room's frozen
// GameSettings picks the column — a story never mixes languages.
import {
  ROOM_LANGUAGE_DEFAULT,
  type RoomLanguage,
  STORY_CAPTION_MAX_GRAPHEMES,
  STORY_TITLE_MAX_GRAPHEMES,
} from "@yuragoo/protocol";
import type { GameOutcome } from "../outcome";

export interface StoryCopyContext {
  readonly scenario: string;
  readonly choices: readonly { choiceId: string; label: string }[];
  readonly outcome: GameOutcome;
  readonly winnerName: string | null;
  readonly leaderLabel: string | null;
  readonly isCompleteRow: boolean;
  readonly language?: RoomLanguage;
}

// Shared ja-grapheme segmenter; protocol's countGraphemes mirrors this
// fallback (code points still never split a combining pair). null on
// runtimes without Intl.Segmenter.
const segmenter: { segment(text: string): Iterable<{ segment: string }> } | null =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

// clip keeps the first max graphemes — the last line of defence so a
// long scenario or label can never push a panel past the schema caps.
const clip = (text: string, max: number): string => {
  const parts =
    segmenter === null ? Array.from(text) : Array.from(segmenter.segment(text), (s) => s.segment);
  return parts.slice(0, max).join("");
};

const clipTrimmed = (text: string, max: number): string => clip(text.trim(), max);

// noContest reasons as the lobby already phrases them.
const NO_CONTEST_REASONS: Readonly<Record<RoomLanguage, Record<string, string>>> = {
  ja: {
    pending: "こたえがまにあわなかった",
    timeout: "じかんぎれ",
    budget: "AIがつかれちゃった",
    aborted: "ちゅうだん",
  },
  en: {
    pending: "the answer didn't make it in time",
    timeout: "time ran out",
    budget: "the AI got too tired",
    aborted: "called off midway",
  },
};

const resultCaption = (ctx: StoryCopyContext, lang: RoomLanguage): string => {
  const outcome = ctx.outcome;
  if (outcome.kind === "winner") {
    const label = clipTrimmed(ctx.choices[outcome.slot]?.label ?? "", 24);
    const name = clipTrimmed(ctx.winnerName ?? "", 20);
    if (lang === "en") {
      if (name.length === 0) {
        return label.length === 0 ? "a winner emerged" : `"${label}" pulled hardest`;
      }
      if (label.length === 0) return `${name} wins`;
      return `"${label}" pulled hardest — ${name} wins`;
    }
    if (name.length === 0) {
      return label.length === 0 ? "しょうぶが ついた" : `${label} が いちばん ひかれた`;
    }
    if (label.length === 0) return `${name} の かち`;
    return `${label} が いちばん ひかれた — ${name} の かち`;
  }
  if (outcome.kind === "draw") {
    return lang === "en"
      ? "a draw — every wish pulled about the same"
      : "ひきわけ — おもいは どれも おなじくらいだった";
  }
  const reason = NO_CONTEST_REASONS[lang][outcome.reason] ?? (lang === "en" ? "void" : "むこう");
  return lang === "en" ? `no winner this time (${reason})` : `しょうぶに ならなかった（${reason}）`;
};

// Titles are short labels; captions carry the one factual sentence. The
// returned pair is clipped at the boundary so callers never re-validate.
export const panelCopy = (
  kind: "start" | "reversal" | "impact" | "endgame" | "result",
  ctx: StoryCopyContext,
): { title: string; caption: string } => {
  const pair = rawCopy(kind, ctx, ctx.language ?? ROOM_LANGUAGE_DEFAULT);
  return {
    title: clip(pair.title, STORY_TITLE_MAX_GRAPHEMES),
    caption: clip(pair.caption, STORY_CAPTION_MAX_GRAPHEMES),
  };
};

const rawCopy = (
  kind: "start" | "reversal" | "impact" | "endgame" | "result",
  ctx: StoryCopyContext,
  lang: RoomLanguage,
): { title: string; caption: string } => {
  // The scenario leaves room for the fixed prefix inside the caption cap.
  const scenario = clipTrimmed(ctx.scenario, STORY_CAPTION_MAX_GRAPHEMES - 15);
  const label = clipTrimmed(ctx.leaderLabel ?? "", 24);
  switch (kind) {
    case "start":
      return lang === "en"
        ? {
            title: "the beginning",
            caption: scenario.length > 0 ? `the story begins — ${scenario}` : "the story begins",
          }
        : {
            title: "はじまり",
            caption:
              scenario.length > 0 ? `おはなしが はじまった — ${scenario}` : "おはなしが はじまった",
          };
    case "reversal":
      return lang === "en"
        ? {
            title: "the tide turns",
            caption: label.length > 0 ? `"${label}" pulled hard` : "the creature changed course",
          }
        : {
            title: "ながれが かわった",
            caption:
              label.length > 0 ? `${label} に ぐーっと かたむいた` : "いきものの むきが かわった",
          };
    case "impact":
      return lang === "en"
        ? { title: "a big wobble", caption: "everyone's wishes moved it at once" }
        : { title: "いっきに ゆれた", caption: "みんなの おもいが いっしゅんで うごいた" };
    case "endgame":
      return lang === "en"
        ? ctx.isCompleteRow
          ? { title: "the last scene", caption: "this is where the story paused" }
          : { title: "the end draws near", caption: "the final answer before the end" }
        : ctx.isCompleteRow
          ? { title: "さいごの ばめん", caption: "ここで おはなしが とまった" }
          : { title: "おわりが ちかづいた", caption: "おわるまえの さいごの こたえ" };
    case "result":
      return {
        title: lang === "en" ? "the result" : "けっか",
        caption: resultCaption(ctx, lang),
      };
  }
};
