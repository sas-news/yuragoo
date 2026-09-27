// Task 41: the wire story must replay chronologically — pickDrafts can
// draft a LATER event into an earlier slot (reversal beats impact by
// kind, not by seq), so buildStory re-sorts panels by eventId. Kept as
// its own file: fixtures here share the ledger harness, not the pick
// rules that highlights.test.ts exercises.
import { expect, test } from "bun:test";
import { buildStory, type StoryEventRow, type StorySource } from "@yuragoo/game-core";

const ROSTER = [
  { id: "aiko", slot: 0 },
  { id: "ren", slot: 1 },
];

const post = (seq: number, playerId: string, text: string) => ({
  postId: `p${seq}`,
  playerId,
  text,
  seq,
});

const decision = (
  seq: number,
  postSeq: number,
  distribution: readonly (readonly [string, number])[],
): StoryEventRow => ({
  seq,
  type: "decisionUpdated",
  payload: {
    postId: `p${postSeq}`,
    revision: postSeq,
    distribution: distribution.map(([choiceId, probability]) => ({ choiceId, probability })),
  },
});

const source = (events: readonly StoryEventRow[]): StorySource => ({
  events,
  posts: [post(1, "aiko", "はじめ"), post(2, "ren", "つぎ")],
  roster: ROSTER,
  choices: [
    { choiceId: "c1", label: "ひかる いし" },
    { choiceId: "c2", label: "みずの おもい" },
  ],
  scenario: "よるの もり",
  outcome: { kind: "winner", playerId: "ren", slot: 1 },
  winnerName: "れん",
});

test("happy: panels emit in ascending eventId when a later event is drafted earlier", () => {
  // Reversal lands on seq 70 while impact lands on seq 40 — the draft
  // order would read reversal first, but the strip must stay by seq.
  const events: StoryEventRow[] = [
    { seq: 10, type: "started", payload: { roster: ROSTER } },
    decision(40, 1, [
      ["c1", 0.8],
      ["c2", 0.2],
    ]),
    decision(70, 2, [
      ["c1", 0.2],
      ["c2", 0.8],
    ]),
    { seq: 90, type: "complete", payload: { cutoffSeq: 2, cause: "rounds" } },
    { seq: 95, type: "finished", payload: { outcome: { kind: "winner" } } },
  ];
  const panels = buildStory(source(events));
  const ids = panels.map((p) => p.eventId);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  // The reversal (seq 70) sorts between impact (seq 40) and the result —
  // the endgame draft dedupes into that same seq-70 row.
  expect(panels.map((p) => p.kind)).toEqual(["start", "impact", "reversal", "result"]);
});
