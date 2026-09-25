// Task 29: deterministic story extraction — panel selection, coverage
// windows and template text from synthetic event ledgers. No game-core
// reducer involved: the story layer reads persisted rows, so fixtures are
// plain StorySource objects.
import { expect, test } from "bun:test";
import { buildStory, type StoryEventRow, type StorySource } from "@yuragoo/game-core";

const graphemes = (text: string): number =>
  Array.from(new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)).length;

const CHOICES = [
  { choiceId: "c1", label: "ひかる いし" },
  { choiceId: "c2", label: "みずの おもい" },
];

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

const source = (
  events: readonly StoryEventRow[],
  over: Partial<StorySource> = {},
): StorySource => ({
  events,
  posts: [],
  roster: ROSTER,
  choices: CHOICES,
  scenario: "よるの もりで いちばん たからものを みつけたい",
  outcome: { kind: "winner", playerId: "ren", slot: 1 },
  winnerName: "れん",
  ...over,
});

test("happy: two reversals and grouped coverage pick the max swing", () => {
  // Two posts land under one evaluation window (seq 3 and 4 cover
  // revision 4) — the group keeps both postIds and both verbatim texts.
  const events: StoryEventRow[] = [
    { seq: 10, type: "started", payload: { roster: ROSTER } },
    decision(30, 2, [
      ["c1", 0.7],
      ["c2", 0.3],
    ]),
    decision(40, 4, [
      ["c1", 0.2],
      ["c2", 0.8],
    ]),
    { seq: 50, type: "complete", payload: { cutoffSeq: 4, cause: "deadline" } },
    { seq: 60, type: "finished", payload: { outcome: { kind: "winner" } } },
  ];
  const panels = buildStory(
    source(events, {
      posts: [
        post(1, "aiko", "いしが すき"),
        post(3, "ren", "みずが すき"),
        post(4, "aiko", "そして うみへ"),
      ],
    }),
  );
  expect(panels.map((p) => p.kind)).toEqual(["start", "reversal", "impact", "result"]);
  expect(panels.map((p) => p.eventId)).toEqual([10, 40, 30, 60]);
  const reversal = panels[1];
  const impact = panels[2];
  // reversal: the 40-seq event flipped the leader from slot0 to slot1 —
  // its covered posts are seq 3 and 4 (prev landed revision was 2).
  expect(reversal?.postIds).toEqual(["p3", "p4"]);
  expect(reversal?.quotes).toEqual([
    { postId: "p3", text: "みずが すき" },
    { postId: "p4", text: "そして うみへ" },
  ]);
  expect(reversal?.pull).toEqual([0.2, 0.8]);
  // impact: reversal already claimed the bigger swing, so the next-best
  // distinct event is seq 30, covering only post seq<=2 (p1 alone).
  expect(impact?.postIds).toEqual(["p1"]);
  expect(impact?.quotes).toEqual([{ postId: "p1", text: "いしが すき" }]);
  // result pull = the last landed distribution, slot order.
  expect(panels[3]?.pull).toEqual([0.2, 0.8]);
  expect(panels[3]?.caption).toContain("みずの おもい");
  expect(panels[3]?.caption).toContain("れん");
});

test("happy: zero posts still yields the 3-panel floor", () => {
  const events: StoryEventRow[] = [
    { seq: 10, type: "started", payload: {} },
    { seq: 50, type: "complete", payload: { cutoffSeq: 0, cause: "deadline" } },
    { seq: 60, type: "finished", payload: { outcome: { kind: "noContest" } } },
  ];
  const panels = buildStory(source(events, { outcome: { kind: "noContest", reason: "timeout" } }));
  expect(panels.map((p) => p.kind)).toEqual(["start", "endgame", "result"]);
  // endgame fell back to the complete row itself — pull stays null.
  expect(panels[1]?.eventId).toBe(50);
  expect(panels[1]?.pull).toBeNull();
  expect(panels[0]?.pull).toBeNull();
  expect(panels[2]?.caption).toContain("じかんぎれ");
});

test("happy: draw and noContest outcomes restate the result fact", () => {
  const base: StoryEventRow[] = [
    { seq: 1, type: "started", payload: {} },
    { seq: 5, type: "complete", payload: { cutoffSeq: 0, cause: "rounds" } },
    { seq: 6, type: "finished", payload: { outcome: {} } },
  ];
  const draw = buildStory(source(base, { outcome: { kind: "draw" } }));
  expect(draw[draw.length - 1]?.caption).toContain("ひきわけ");
  const pending = buildStory(source(base, { outcome: { kind: "noContest", reason: "pending" } }));
  expect(pending[pending.length - 1]?.caption).toContain("こたえがまにあわなかった");
  const aborted = buildStory(source(base, { outcome: { kind: "noContest", reason: "aborted" } }));
  expect(aborted[aborted.length - 1]?.caption).toContain("ちゅうだん");
});

test("happy: equal impact keeps the earlier seq", () => {
  // Both landings move 0.15 of mass (impact 0.15 each) — the earlier
  // event wins the impact panel while the reversal scores seq 40 higher.
  const events: StoryEventRow[] = [
    { seq: 10, type: "started", payload: {} },
    decision(30, 1, [
      ["c1", 0.65],
      ["c2", 0.35],
    ]),
    decision(40, 2, [
      ["c1", 0.5],
      ["c2", 0.5],
    ]),
    { seq: 50, type: "complete", payload: { cutoffSeq: 2, cause: "rounds" } },
    { seq: 60, type: "finished", payload: {} },
  ];
  const panels = buildStory(source(events, { outcome: { kind: "draw" } }));
  const impact = panels.find((p) => p.kind === "impact");
  expect(impact?.eventId).toBe(30);
});

test("caps: long scenario and labels stay inside the grapheme caps", () => {
  const longScenario = "あ".repeat(120);
  const longLabel = "い".repeat(80);
  const events: StoryEventRow[] = [
    { seq: 1, type: "started", payload: {} },
    decision(3, 1, [
      ["c1", 0.9],
      ["c2", 0.1],
    ]),
    decision(5, 2, [
      ["c1", 0.1],
      ["c2", 0.9],
    ]),
    { seq: 7, type: "complete", payload: { cutoffSeq: 2, cause: "rounds" } },
    { seq: 9, type: "finished", payload: {} },
  ];
  const panels = buildStory(
    source(events, {
      scenario: longScenario,
      choices: [
        { choiceId: "c1", label: longLabel },
        { choiceId: "c2", label: "みずの おもい" },
      ],
      outcome: { kind: "winner", playerId: "aiko", slot: 0 },
      winnerName: "あいこ",
    }),
  );
  for (const p of panels) {
    expect(graphemes(p.title)).toBeLessThanOrEqual(40);
    expect(graphemes(p.caption)).toBeLessThanOrEqual(80);
  }
  const start = panels[0];
  expect(start?.caption.startsWith("おはなしが はじまった")).toBe(true);
  const reversal = panels.find((p) => p.kind === "reversal");
  // The reversal caption carries the new leader's (clipped) label.
  expect(reversal?.caption).toContain("かたむいた");
  const result = panels.find((p) => p.kind === "result");
  expect(result?.caption).toContain("あいこ");
  // Wire keys never become readable copy — the raw id stays out.
  expect(result?.caption).not.toContain("aiko");
});

test("defensive: malformed decisionUpdated rows are skipped entirely", () => {
  const events: StoryEventRow[] = [
    { seq: 10, type: "started", payload: {} },
    { seq: 20, type: "decisionUpdated", payload: "not-an-object" },
    {
      seq: 25,
      type: "decisionUpdated",
      payload: { postId: "pX", revision: 1, distribution: [{ choiceId: "c1" }] },
    },
    {
      seq: 27,
      type: "decisionUpdated",
      payload: { postId: "pY", revision: "oops", distribution: [] },
    },
    decision(30, 5, [
      ["c1", 0.7],
      ["c2", 0.3],
    ]),
    { seq: 50, type: "complete", payload: { cutoffSeq: 6, cause: "deadline" } },
    { seq: 60, type: "finished", payload: {} },
  ];
  const panels = buildStory(
    source(events, { posts: [post(5, "aiko", "こんにちは"), post(6, "ren", "つぎ")] }),
  );
  // Only the well-formed row landed: no reversal, impact covers seq<=5,
  // and the endgame pick is that same event.
  const kinds = panels.map((p) => p.kind);
  expect(kinds).not.toContain("reversal");
  const impact = panels.find((p) => p.kind === "impact");
  expect(impact?.eventId).toBe(30);
  // post seq 6 is inside the complete cutoff but outside revision 5 — the
  // window stays post-seq based, so it is not credited here.
  expect(impact?.postIds).toEqual(["p5"]);
  // A post outside the window (seq 12 > revision 9) leaves coverage
  // empty — the panel still cites the evaluated postId itself.
  const emptyCoverage = buildStory(
    source(
      events.map((e) =>
        e.seq === 30
          ? decision(30, 9, [
              ["c1", 0.7],
              ["c2", 0.3],
            ])
          : e,
      ),
      { posts: [post(12, "aiko", "おくれた ひとこと")] },
    ),
  );
  expect(emptyCoverage.find((p) => p.kind === "impact")?.postIds).toEqual(["p9"]);
});
