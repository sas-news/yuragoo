import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  type DecisionProvider,
  type EvalCase,
  EvalContractError,
  type EvalExpectation,
  type EvalSuite,
  evaluateRun,
  JevProviderError,
  parseEvalSuite,
  runEvalSuite,
} from "@yuragoo/ai";
import {
  type DecisionResult,
  type DecisionState,
  parseChoiceId,
  parseDecisionRevision,
} from "@yuragoo/protocol";

const resultFor = (probs: Readonly<Record<string, number>>, pick: string): DecisionResult => ({
  revision: parseDecisionRevision(1),
  model: "jev-1.13.0",
  selectedChoiceId: parseChoiceId(pick),
  confidence: 0.5,
  distribution: Object.entries(probs).map(([id, probability]) => ({
    choiceId: parseChoiceId(id),
    probability,
  })),
  usage: { inputTokens: 10, outputTokens: 5 },
});
const providerOf = (impl: (state: DecisionState) => DecisionResult): DecisionProvider => ({
  evaluate: (state) => Promise.resolve(impl(state)),
});
const constant = (result: DecisionResult): DecisionProvider => providerOf(() => result);
const failing = (error: Error): DecisionProvider => ({
  evaluate: () => Promise.reject(error),
});
const opts = (nowMs: () => number = () => 0) => {
  let n = 0;
  const hashRequest = () => {
    n += 1;
    return `h${n}`;
  };
  return { nowMs, hashRequest };
};

const CASE_A = {
  id: "case-a",
  description: "d",
  scenario: "sa",
  persona: "p",
  activeContext: [],
  choices: [
    { id: "a", label: "x" },
    { id: "b", label: "y" },
  ],
  expect: { top: ["a"] },
};
const CASE_B = { ...CASE_A, id: "case-b", scenario: "sb" };
const miniSuite = (cases: readonly unknown[], gate?: unknown): EvalSuite =>
  parseEvalSuite({
    name: "mini",
    gate: gate ?? { runsPerCase: 3, minRunsPassing: 2, minPassingCases: cases.length, p95Ms: 3000 },
    cases,
  });
const evalCase = (expect: EvalExpectation): EvalCase => ({
  id: "case-x",
  description: "d",
  scenario: "s",
  persona: "p",
  activeContext: [],
  choices: [
    { id: parseChoiceId("a"), label: "x" },
    { id: parseChoiceId("b"), label: "y" },
  ] as EvalCase["choices"],
  expect,
});

test("happy: the ja-v1 suite parses with 12 well-formed cases", () => {
  // Given the checked-in suite file
  const raw: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "../../jev-evals/ja-v1.json"), "utf8"),
  );
  const suite = parseEvalSuite(raw);
  // Then the gate and every expectation reference real choice ids
  expect(suite.name).toBe("ja-v1");
  expect(suite.gate).toEqual({
    runsPerCase: 3,
    minRunsPassing: 2,
    minPassingCases: 10,
    p95Ms: 3000,
  });
  expect(suite.cases).toHaveLength(12);
  const counts = new Map<number, number>();
  for (const c of suite.cases) {
    counts.set(c.choices.length, (counts.get(c.choices.length) ?? 0) + 1);
    const ids = new Set(c.choices.map((x) => String(x.id)));
    const referenced = [...(c.expect.top ?? []), ...(c.expect.order ?? []).flat()];
    for (const [a, b] of c.expect.close ?? []) referenced.push(a, b);
    for (const id of referenced) expect(ids.has(id)).toBe(true);
  }
  expect(counts.get(2) ?? 0).toBeGreaterThanOrEqual(3);
  expect(counts.get(4) ?? 0).toBeGreaterThanOrEqual(6);
  expect(counts.get(6) ?? 0).toBeGreaterThanOrEqual(2);
});
test("failure: malformed suites are rejected", () => {
  const good = {
    name: "mini",
    gate: { runsPerCase: 3, minRunsPassing: 2, minPassingCases: 1, p95Ms: 3000 },
    cases: [CASE_A],
  };
  const rejects = (mutate: (s: Record<string, unknown>) => void) => {
    const s = structuredClone(good) as Record<string, unknown>;
    mutate(s);
    expect(() => parseEvalSuite(s)).toThrow(EvalContractError);
  };
  const firstCase = (s: Record<string, unknown>) => {
    const c = (s.cases as Record<string, unknown>[])[0];
    if (c === undefined) throw new Error("test setup");
    return c;
  };
  rejects((s) => (s.cases as unknown[]).push({ ...CASE_A })); // duplicate case id
  rejects((s) => Object.assign(firstCase(s), { expect: { top: ["z"] } })); // bad ref
  rejects((s) => Object.assign(firstCase(s), { expect: {} })); // empty expect
  rejects((s) => Object.assign(s.gate as object, { minRunsPassing: 4 })); // > runsPerCase
  rejects((s) => {
    s.cases = Array.from({ length: 65 }, (_, i) => ({ ...CASE_A, id: `case-${i}` }));
  }); // > 64 cases
  rejects((s) => Object.assign(s, { name: "  " })); // blank name
  rejects((s) => Object.assign(firstCase(s), { id: "X" })); // bad case id
  rejects((s) => Object.assign(s.gate as object, { runsPerCase: 6 })); // out of range
  rejects((s) => Object.assign(firstCase(s), { extra: 1 })); // unknown case key
});
test("happy: directional assertions pass a matching result", () => {
  const c = evalCase({ top: ["a"], order: [["a", "b"]], close: [["a", "b", 0.7]] });
  expect(evaluateRun(c, resultFor({ a: 0.7, b: 0.3 }, "a"))).toEqual([]);
});
test("failure: each assertion emits its violation string", () => {
  const r = resultFor({ a: 0.3, b: 0.7 }, "b");
  expect(evaluateRun(evalCase({ top: ["a"] }), r)).toEqual(["top:not-in-set"]);
  expect(evaluateRun(evalCase({ order: [["a", "b"]] }), r)).toEqual(["order:a>b"]);
  expect(evaluateRun(evalCase({ close: [["a", "b", 0.2]] }), r)).toEqual(["close:a|b"]);
});
test("failure: a non-jev model is flagged defensively", () => {
  const bad = { ...resultFor({ a: 0.7, b: 0.3 }, "a"), model: "jev-9.9.9" };
  expect(evaluateRun(evalCase({ top: ["a"] }), bad as unknown as DecisionResult)).toEqual([
    "model:unexpected",
  ]);
});
test("happy: an all-pass provider yields a pass manifest", async () => {
  const manifest = await runEvalSuite(
    miniSuite([CASE_A, CASE_B]),
    constant(resultFor({ a: 0.9, b: 0.1 }, "a")),
    opts(),
  );
  expect(manifest.verdict).toBe("pass");
  expect(manifest.reasons).toEqual([]);
  expect(manifest.runs).toHaveLength(6); // 2 cases x 3 runs
  for (const run of manifest.runs) {
    expect(run.ok).toBe(true);
    expect(run.requestHash.length).toBeGreaterThan(0);
    expect(run.model).toBe("jev-1.13.0");
    expect(run.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
  }
  expect(manifest.schemaSuccessRate).toBe(1);
  expect(manifest.passingCases).toBe(2);
});
test("failure: an all-error provider fails with schema-success<100%", async () => {
  const provider = failing(new JevProviderError("upstream", true, "boom"));
  const manifest = await runEvalSuite(miniSuite([CASE_A]), provider, opts());
  expect(manifest.verdict).toBe("fail");
  expect(manifest.schemaSuccessRate).toBe(0);
  expect(manifest.passingCases).toBe(0);
  expect(manifest.reasons).toContain("schema-success<100%");
  expect(manifest.reasons).toContain("passing-cases 0<1");
  for (const run of manifest.runs) {
    expect(run.ok).toBe(false);
    expect(run.violations).toEqual(["error:upstream"]);
    expect(run.model).toBe("");
    expect(run.usage).toBeNull();
  }
});
test("failure: quota and invalid-response errors fail the suite too", async () => {
  for (const kind of ["quota", "invalid-response"] as const) {
    const provider = failing(new JevProviderError(kind, false, "cap"));
    const manifest = await runEvalSuite(miniSuite([CASE_A]), provider, opts());
    expect(manifest.verdict).toBe("fail");
    expect(manifest.schemaSuccessRate).toBe(0);
    expect(manifest.runs[0]?.violations).toEqual([`error:${kind}`]);
  }
});
test("edge: a null provider yields a blocked manifest with zero runs", async () => {
  const manifest = await runEvalSuite(miniSuite([CASE_A]), null, opts());
  expect(manifest).toMatchObject({
    suite: "mini",
    verdict: "blocked",
    reasons: ["no-provider"],
    runs: [],
    totalCases: 1,
  });
});
test("failure: a case failing 2/3 runs drops passingCases below the gate", async () => {
  // Given case-b failing its first two runs then recovering (1 passing < 2)
  const suite = miniSuite([CASE_A, CASE_B]);
  let badCalls = 0;
  const provider = providerOf((state) => {
    if (state.scenario !== "sb") return resultFor({ a: 0.9, b: 0.1 }, "a");
    badCalls += 1;
    return badCalls <= 2 ? resultFor({ a: 0.2, b: 0.8 }, "b") : resultFor({ a: 0.9, b: 0.1 }, "a");
  });
  const manifest = await runEvalSuite(suite, provider, opts());
  expect(manifest.verdict).toBe("fail");
  expect(manifest.passingCases).toBe(1);
  expect(manifest.reasons).toContain("passing-cases 1<2");
});
test("failure: a p95 latency breach fails the suite", async () => {
  let t = 0;
  const nowMs = () => (t += 4000); // each run measures 4000ms
  const manifest = await runEvalSuite(
    miniSuite([CASE_A]),
    constant(resultFor({ a: 0.9, b: 0.1 }, "a")),
    opts(nowMs),
  );
  expect(manifest.verdict).toBe("fail");
  expect(manifest.p95LatencyMs).toBe(4000);
  expect(manifest.reasons).toContain("p95 4000>3000");
});
test("edge: identical suite and provider produce identical manifests", async () => {
  const suite = miniSuite([CASE_A, CASE_B]);
  const run = () => runEvalSuite(suite, constant(resultFor({ a: 0.9, b: 0.1 }, "a")), opts());
  expect(await run()).toEqual(await run());
});
