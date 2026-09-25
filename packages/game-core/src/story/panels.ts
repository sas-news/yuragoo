// Panel materialization (Task 29): turns the picked events into
// StoryPanels — the decision-panel coverage window, the schema-safe pull
// vector and the template copy — and exposes buildStory, the public
// extractor. Panels are built strictly inside the wire contract
// (packages/protocol/src/story.ts): eventId is the depicted events.seq,
// quotes are the covered posts verbatim, and pull is a 2..6 slot vector.
import type { StoryPanel, StoryQuote } from "@yuragoo/protocol";
import { pickDrafts, type LandedDecision, type StorySource } from "./highlights";
import { panelCopy } from "./templates";

// A decision panel still to be materialized. landedIndex points into the
// caller's landed array (-1 for non-decision events) so coverage resolves
// against the previous landed revision. leaderLabel is the reversal
// panel's to-slot caption hint.
export interface PanelDraft {
  readonly kind: "start" | "reversal" | "impact" | "endgame" | "result";
  readonly seq: number;
  readonly pull: readonly number[] | null;
  readonly landedIndex: number;
  readonly leaderLabel: string | null;
}

type SourcePost = StorySource["posts"][number];

// postIds + quotes of one decision panel: every post with
// prevLandedRevision < post.seq <= this revision, in seq order — a grouped
// landing window is quoted in full so the group is never credited to its
// last poster alone. An empty window still cites the evaluated post
// itself. 24 is the wire cap in storyPanelSchema; anything over would be
// rejected.
const coverageOf = (
  posts: readonly SourcePost[],
  landed: readonly LandedDecision[],
  landedIndex: number,
): { postIds: string[]; quotes: StoryQuote[] } => {
  const event = landed[landedIndex];
  if (event === undefined) return { postIds: [], quotes: [] };
  const prevRevision = landed[landedIndex - 1]?.revision ?? 0;
  const covered = posts.filter((p) => p.seq > prevRevision && p.seq <= event.revision).slice(0, 24);
  if (covered.length === 0) {
    return { postIds: [event.postId], quotes: [{ postId: event.postId, text: "" }] };
  }
  return {
    postIds: covered.map((p) => p.postId),
    quotes: covered.map((p) => ({ postId: p.postId, text: p.text })),
  };
};

// The panel schema hard-caps pull at 2..6 slots; a hand-built source that
// falls outside drops to rest instead of emitting an invalid panel.
const validPull = (pull: readonly number[] | null): number[] | null => {
  if (pull === null || pull.length < 2 || pull.length > 6) return null;
  return [...pull];
};

const buildPanel = (
  d: PanelDraft,
  source: StorySource,
  landed: readonly LandedDecision[],
): StoryPanel => {
  const coverage =
    d.landedIndex >= 0
      ? coverageOf(source.posts, landed, d.landedIndex)
      : { postIds: [], quotes: [] };
  const copy = panelCopy(d.kind, {
    scenario: source.scenario,
    choices: source.choices,
    outcome: source.outcome,
    leaderLabel: d.leaderLabel,
    isCompleteRow: d.kind === "endgame" && d.landedIndex < 0,
  });
  return {
    kind: d.kind,
    eventId: d.seq,
    postIds: coverage.postIds,
    quotes: coverage.quotes,
    pull: validPull(d.pull),
    title: copy.title,
    caption: copy.caption,
  };
};

// Drafts materialize in story order (start, reversal, impact, endgame,
// result); dedupe keeps the FIRST panel claiming an eventId, so an
// endgame pointing at the reversal's event simply yields a shorter story.
// started + complete + finished always supply three distinct events, so
// the 3..5 bound needs no fabricated panels.
export const buildStory = (source: StorySource): readonly StoryPanel[] => {
  const { drafts, landed } = pickDrafts(source);
  const seen = new Set<number>();
  const panels: StoryPanel[] = [];
  for (const d of drafts) {
    if (d === null || seen.has(d.seq)) continue;
    seen.add(d.seq);
    panels.push(buildPanel(d, source, landed));
  }
  return panels;
};
