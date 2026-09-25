// Kamishibai ending contract (Task 29-32): the shared wire shape of a
// match's picture-story recap. Panels are extracted deterministically
// from the persisted event ledger (packages/game-core/story) — every
// panel cites the events.seq it depicts so clients and audits can trace
// the story back to facts. Human posts appear only inside `quotes`
// (verbatim); title/caption prose is template or generated text, capped
// at 40/80 graphemes like every other text bound (Intl.Segmenter).
import { z } from "zod";
import { gameOutcomeSchema } from "./snapshot";
import { countGraphemes } from "./text";

export const STORY_TITLE_MAX_GRAPHEMES = 40;
export const STORY_CAPTION_MAX_GRAPHEMES = 80;
export const STORY_PANEL_MIN = 3;
export const STORY_PANEL_MAX = 5;

const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const graphemeCap = (max: number) =>
  z.string().superRefine((value, ctx) => {
    const graphemes = countGraphemes(value);
    if (graphemes > max) {
      ctx.addIssue({
        code: "custom",
        message: "TextTooLong",
        input: value,
        params: { reason: "too-long", graphemes, max },
      });
    }
  });

export const storyPanelKindSchema = z.enum(["start", "reversal", "impact", "endgame", "result"]);
export type StoryPanelKind = z.infer<typeof storyPanelKindSchema>;

// A verbatim player post shown on the panel — the story's facts are the
// players' own words; generated prose never quotes or invents text.
export const storyQuoteSchema = z.strictObject({
  postId: z.string().min(1),
  text: z.string(),
});
export type StoryQuote = z.infer<typeof storyQuoteSchema>;

// One kamishibai page. `pull` is the canonical pose input: per-roster-slot
// normalized attraction (index = roster slot, same order as the committed
// choices) — null renders the creature at rest (the start panel).
// `postIds` lists the posts the depicted decision covered: one entry for a
// single-post evaluation, several for a grouped landing window — the
// group is never credited to the last poster alone.
export const storyPanelSchema = z.strictObject({
  kind: storyPanelKindSchema,
  eventId: safeInt, // events.seq of the depicted persisted event
  postIds: z.array(z.string().min(1)).max(24),
  quotes: z.array(storyQuoteSchema).max(24),
  pull: z.array(z.number().min(0).max(1)).min(2).max(6).nullable(),
  title: graphemeCap(STORY_TITLE_MAX_GRAPHEMES),
  caption: graphemeCap(STORY_CAPTION_MAX_GRAPHEMES),
});
export type StoryPanel = z.infer<typeof storyPanelSchema>;

// The ending payload: one identical panel set for every member. `generated`
// marks whether captions came from the post-game generation call (true) or
// the deterministic templates (false, also the fallback state). gameEpoch
// pins the game generation — a rematch's epoch makes stale panels obvious.
export const endingStorySchema = z.strictObject({
  gameEpoch: safeInt,
  outcome: gameOutcomeSchema,
  generated: z.boolean(),
  panels: z.array(storyPanelSchema).min(STORY_PANEL_MIN).max(STORY_PANEL_MAX),
});
export type EndingStory = z.infer<typeof endingStorySchema>;

export const parseEndingStory = (input: unknown): EndingStory | null => {
  const result = endingStorySchema.safeParse(input);
  return result.success ? result.data : null;
};
