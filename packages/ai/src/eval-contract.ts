// Eval suite contract: strict validation for the JSON suite files under
// tests/jev-evals. Pure — no I/O; callers hand in already-parsed JSON.
import {
  choiceIdSchema,
  type DecisionChoice,
  type RoomLanguage,
  roomLanguageSchema,
} from "@yuragoo/protocol";

export interface EvalExpectation {
  readonly top?: readonly string[]; // some argmax choiceId must be in this set
  readonly order?: readonly (readonly [string, string])[]; // p(hi) must exceed p(lo)
  readonly close?: readonly (readonly [string, string, number])[]; // |p(a)-p(b)| <= margin
}
export interface EvalCase {
  readonly id: string; // [a-z0-9-]{3,64}
  readonly description: string;
  readonly scenario: string;
  readonly persona: string;
  readonly activeContext: readonly string[];
  readonly choices: readonly DecisionChoice[]; // 2..6 unique ids
  // Shared-content language of the case — rides into the DecisionState so
  // the en suite exercises the English instructions/criteria. Absent = ja.
  readonly language?: RoomLanguage;
  readonly expect: EvalExpectation;
}
export interface EvalGate {
  readonly runsPerCase: number; // 1..5
  readonly minRunsPassing: number; // per case
  readonly minPassingCases: number;
  readonly p95Ms: number; // positive
}
export interface EvalSuite {
  readonly name: string;
  readonly gate: EvalGate;
  readonly cases: readonly EvalCase[];
}

// Suite-contract failure. Messages carry structural detail only (slot, case
// id, key names) — never raw scenario, persona or context text.
export class EvalContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalContractError";
  }
}

const MAX_CASES = 64;
const MAX_CONTEXT = 48;
const CASE_ID = /^[a-z0-9-]{3,64}$/;
function fail(message: string): never {
  throw new EvalContractError(message);
}
const obj = (v: unknown, w: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail(`${w} must be an object`);
const keys = (o: Record<string, unknown>, ks: readonly string[], w: string): void => {
  for (const k of Object.keys(o)) if (!ks.includes(k)) fail(`${w}: unknown key "${k}"`);
};
const text = (v: unknown, w: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v : fail(`${w} must be a nonempty string`);
const int = (v: unknown, w: string, lo: number, hi: number): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi
    ? v
    : fail(`${w} must be an integer in ${lo}..${hi}`);
const arr = (v: unknown, w: string, min: number): unknown[] =>
  Array.isArray(v) && v.length >= min ? v : fail(`${w} must be an array of ${min}+ items`);

const expectation = (v: unknown, ids: ReadonlySet<string>, w: string): EvalExpectation => {
  const o = obj(v, `${w}.expect`);
  keys(o, ["top", "order", "close"], `${w}.expect`);
  const id = (x: unknown): string =>
    typeof x === "string" && ids.has(x) ? x : fail(`${w}.expect references an unknown choice`);
  const out: {
    top?: string[];
    order?: (readonly [string, string])[];
    close?: (readonly [string, string, number])[];
  } = {};
  if (o.top !== undefined) out.top = arr(o.top, `${w}.expect.top`, 1).map(id);
  if (o.order !== undefined) {
    out.order = arr(o.order, `${w}.expect.order`, 1).map((x): readonly [string, string] => {
      const p = arr(x, `${w}.expect.order`, 2);
      const hi = id(p[0]);
      const lo = id(p[1]);
      if (p.length !== 2 || hi === lo) fail(`${w}.expect.order pairs must be [hi,lo]`);
      return [hi, lo];
    });
  }
  if (o.close !== undefined) {
    out.close = arr(o.close, `${w}.expect.close`, 1).map((x): readonly [string, string, number] => {
      const t = arr(x, `${w}.expect.close`, 3);
      const a = id(t[0]);
      const b = id(t[1]);
      const m = t[2];
      if (t.length !== 3 || a === b || typeof m !== "number" || !Number.isFinite(m) || m < 0) {
        fail(`${w}.expect.close entries must be [a,b,margin>=0]`);
      }
      return [a, b, m];
    });
  }
  if (out.top === undefined && out.order === undefined && out.close === undefined) {
    fail(`${w}.expect needs at least one assertion`);
  }
  return out;
};

const evalCase = (v: unknown, i: number): EvalCase => {
  const slot = `cases[${i}]`;
  const o = obj(v, slot);
  const fields = [
    "id",
    "description",
    "scenario",
    "persona",
    "activeContext",
    "choices",
    "language",
    "expect",
  ];
  keys(o, fields, slot);
  const caseId = o.id;
  if (typeof caseId !== "string" || !CASE_ID.test(caseId)) {
    fail(`${slot}.id must match ${CASE_ID.source}`);
  }
  const w = `case ${caseId}`;
  const ctx = arr(o.activeContext, `${w}.activeContext`, 0);
  if (ctx.length > MAX_CONTEXT || ctx.some((x) => typeof x !== "string")) {
    fail(`${w}.activeContext allows up to ${MAX_CONTEXT} strings`);
  }
  const raw = arr(o.choices, `${w}.choices`, 2);
  if (raw.length > 6) fail(`${w}.choices allows at most 6`);
  const choices: DecisionChoice[] = raw.map((c, j) => {
    const co = obj(c, `${w}.choices[${j}]`);
    keys(co, ["id", "label"], `${w}.choices[${j}]`);
    const parsed = choiceIdSchema.safeParse(co.id);
    const label = co.label;
    const labelOk = typeof label === "string" && label.trim() !== "" && label.length <= 160;
    if (!parsed.success || !labelOk) fail(`${w}.choices[${j}] is invalid`);
    return { id: parsed.data, label: label as string };
  });
  const ids = new Set(choices.map((c) => String(c.id)));
  if (ids.size !== choices.length) fail(`${w}.choices ids must be unique`);
  const lang = o.language === undefined ? undefined : roomLanguageSchema.parse(o.language);
  return {
    id: caseId,
    description: text(o.description, `${w}.description`),
    scenario: text(o.scenario, `${w}.scenario`),
    persona: text(o.persona, `${w}.persona`),
    activeContext: ctx as string[],
    choices,
    ...(lang === undefined ? {} : { language: lang }),
    expect: expectation(o.expect, ids, w),
  };
};

export const parseEvalSuite = (input: unknown): EvalSuite => {
  const o = obj(input, "suite");
  keys(o, ["name", "gate", "cases"], "suite");
  const g = obj(o.gate, "suite.gate");
  keys(g, ["runsPerCase", "minRunsPassing", "minPassingCases", "p95Ms"], "suite.gate");
  const runsPerCase = int(g.runsPerCase, "gate.runsPerCase", 1, 5);
  const minRunsPassing = int(g.minRunsPassing, "gate.minRunsPassing", 1, 5);
  const raw = arr(o.cases, "suite.cases", 1);
  if (raw.length > MAX_CASES) fail(`suite.cases allows at most ${MAX_CASES}`);
  const minPassingCases = int(g.minPassingCases, "gate.minPassingCases", 1, MAX_CASES);
  const p95Ms = g.p95Ms;
  if (typeof p95Ms !== "number" || !Number.isFinite(p95Ms) || p95Ms <= 0) {
    fail("gate.p95Ms must be a positive number");
  }
  const cases = raw.map(evalCase);
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) fail(`duplicate case id "${c.id}"`);
    seen.add(c.id);
  }
  if (minRunsPassing > runsPerCase) fail("gate.minRunsPassing exceeds gate.runsPerCase");
  if (minPassingCases > cases.length) fail("gate.minPassingCases exceeds the case count");
  const gate = { runsPerCase, minRunsPassing, minPassingCases, p95Ms };
  return { name: text(o.name, "suite.name"), gate, cases };
};
