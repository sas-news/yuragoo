// Deterministic story text (Task 29): the template fallback for panel
// titles and captions. Copy may restate facts already on the panel —
// scenario, committed choice labels, the outcome — and never invents
// players, winners or quotes. Every string passes through a grapheme
// clip so schema caps (40 title / 80 caption, Intl.Segmenter) hold even
// when a long scenario or label would overflow mid-cluster.
import { STORY_CAPTION_MAX_GRAPHEMES, STORY_TITLE_MAX_GRAPHEMES } from "@yuragoo/protocol";
import type { GameOutcome } from "../outcome";

export interface StoryCopyContext {
  readonly scenario: string;
  readonly choices: readonly { choiceId: string; label: string }[];
  readonly outcome: GameOutcome;
  readonly winnerName: string | null;
  readonly leaderLabel: string | null;
  readonly isCompleteRow: boolean;
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

// noContest reasons as the lobby already phrases them (soft hiragana).
const NO_CONTEST_REASONS: Readonly<Record<string, string>> = {
  pending: "こたえがまにあわなかった",
  timeout: "じかんぎれ",
  budget: "AIがつかれちゃった",
  aborted: "ちゅうだん",
};

const resultCaption = (ctx: StoryCopyContext): string => {
  const outcome = ctx.outcome;
  if (outcome.kind === "winner") {
    const label = clipTrimmed(ctx.choices[outcome.slot]?.label ?? "", 24);
    const name = clipTrimmed(ctx.winnerName ?? "", 20);
    if (name.length === 0) {
      return label.length === 0 ? "しょうぶが ついた" : `${label} が いちばん ひかれた`;
    }
    if (label.length === 0) return `${name} の かち`;
    return `${label} が いちばん ひかれた — ${name} の かち`;
  }
  if (outcome.kind === "draw") return "ひきわけ — おもいは どれも おなじくらいだった";
  const reason = NO_CONTEST_REASONS[outcome.reason] ?? "むこう";
  return `しょうぶに ならなかった（${reason}）`;
};

// Titles are short labels; captions carry the one factual sentence. The
// returned pair is clipped at the boundary so callers never re-validate.
export const panelCopy = (
  kind: "start" | "reversal" | "impact" | "endgame" | "result",
  ctx: StoryCopyContext,
): { title: string; caption: string } => {
  const pair = rawCopy(kind, ctx);
  return {
    title: clip(pair.title, STORY_TITLE_MAX_GRAPHEMES),
    caption: clip(pair.caption, STORY_CAPTION_MAX_GRAPHEMES),
  };
};

const rawCopy = (
  kind: "start" | "reversal" | "impact" | "endgame" | "result",
  ctx: StoryCopyContext,
): { title: string; caption: string } => {
  // The scenario leaves room for the fixed prefix inside the caption cap.
  const scenario = clipTrimmed(ctx.scenario, STORY_CAPTION_MAX_GRAPHEMES - 15);
  const label = clipTrimmed(ctx.leaderLabel ?? "", 24);
  switch (kind) {
    case "start":
      return {
        title: "はじまり",
        caption:
          scenario.length > 0 ? `おはなしが はじまった — ${scenario}` : "おはなしが はじまった",
      };
    case "reversal":
      return {
        title: "ながれが かわった",
        caption:
          label.length > 0 ? `${label} に ぐーっと かたむいた` : "いきものの むきが かわった",
      };
    case "impact":
      return { title: "いっきに ゆれた", caption: "みんなの おもいが いっしゅんで うごいた" };
    case "endgame":
      return ctx.isCompleteRow
        ? { title: "さいごの ばめん", caption: "ここで おはなしが とまった" }
        : { title: "おわりが ちかづいた", caption: "おわるまえの さいごの こたえ" };
    case "result":
      return { title: "けっか", caption: resultCaption(ctx) };
  }
};
