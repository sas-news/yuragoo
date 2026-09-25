// Free-text post validation shared by client and server boundaries. The
// contract counts GRAPHEMES (Intl.Segmenter, ja locale) so combining marks,
// emoji and Japanese text are never split mid-character. This module only
// validates length/emptiness — it makes no HTML-safety claims; rendering
// safety is React's escaping job.
import { z } from "zod";

// 投稿上限 140 grapheme (game and input contract).
export const POST_TEXT_MAX_GRAPHEMES = 140;

type Segmenter = { segment(text: string): Iterable<unknown> };

// Built once; null when the runtime lacks Intl.Segmenter entirely.
const segmenter: Segmenter | null =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

export const countGraphemes = (text: string): number => {
  if (segmenter === null) {
    // Fallback counts Unicode code points — still combining-safe enough for
    // tests, though it over-counts clusters like か+゙.
    return Array.from(text).length;
  }
  return Array.from(segmenter.segment(text)).length;
};

export type PostTextFailureReason = "empty" | "too-long";

export type PostTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: PostTextFailureReason; readonly graphemes: number };

// validatePostText trims, then counts graphemes of the trimmed text.
export const validatePostText = (text: string): PostTextResult => {
  const trimmed = text.trim();
  const graphemes = countGraphemes(trimmed);
  if (graphemes === 0) {
    return { ok: false, reason: "empty", graphemes };
  }
  if (graphemes > POST_TEXT_MAX_GRAPHEMES) {
    return { ok: false, reason: "too-long", graphemes };
  }
  return { ok: true, text: trimmed };
};

// Boundary schema mirror of validatePostText for inbound envelopes. Issues
// carry params.reason so callers can branch without parsing messages.
export const postTextSchema = z.string().superRefine((value, ctx) => {
  const trimmed = value.trim();
  const graphemes = countGraphemes(trimmed);
  if (graphemes === 0) {
    ctx.addIssue({
      code: "custom",
      message: "TextEmpty",
      input: value,
      params: { reason: "empty", graphemes },
    });
    return;
  }
  if (graphemes > POST_TEXT_MAX_GRAPHEMES) {
    ctx.addIssue({
      code: "custom",
      message: "TextTooLong",
      input: value,
      params: { reason: "too-long", graphemes },
    });
  }
});
export type PostText = z.infer<typeof postTextSchema>;
