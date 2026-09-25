// Eval runner for the Japanese JEV behavior-evaluation gate: per-run
// directional assertions and an aggregate verdict manifest. Pure — the CLI
// injects the provider, clock and request hashing; no I/O happens here.
import {
  createDecisionEnvelope,
  type DecisionResult,
  type DecisionState,
  parseDecisionRevision,
} from "@yuragoo/protocol";
import type { EvalCase, EvalSuite } from "./eval-contract";
import type { DecisionProvider } from "./provider";

export * from "./eval-contract";

export interface EvalRunRecord {
  readonly caseId: string;
  readonly runIndex: number;
  readonly ok: boolean;
  readonly violations: readonly string[]; // e.g. "top:not-in-set", "error:quota"
  readonly model: string;
  readonly requestHash: string;
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}
export interface EvalManifest {
  readonly suite: string;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly reasons: readonly string[]; // e.g. "schema-success<100%", "p95 3100>3000"
  readonly schemaSuccessRate: number;
  readonly passingCases: number;
  readonly totalCases: number;
  readonly p95LatencyMs: number;
  readonly runs: readonly EvalRunRecord[];
}

// Directional assertions only: no probability is pinned to an exact value.
export const evaluateRun = (c: EvalCase, result: DecisionResult): readonly string[] => {
  const violations: string[] = [];
  if (result.model !== "jev-1.13.0") violations.push("model:unexpected");
  const p = new Map(result.distribution.map((d) => [String(d.choiceId), d.probability]));
  const top = c.expect.top;
  const maxP = Math.max(0, ...result.distribution.map((d) => d.probability));
  const topHit = result.distribution.some(
    (d) => d.probability === maxP && (top ?? []).includes(String(d.choiceId)),
  );
  if (top !== undefined && !topHit) violations.push("top:not-in-set");
  for (const [hi, lo] of c.expect.order ?? []) {
    if ((p.get(hi) ?? 0) <= (p.get(lo) ?? 0)) violations.push(`order:${hi}>${lo}`);
  }
  for (const [a, b, margin] of c.expect.close ?? []) {
    if (Math.abs((p.get(a) ?? 0) - (p.get(b) ?? 0)) > margin) violations.push(`close:${a}|${b}`);
  }
  return violations;
};

const errorKind = (e: unknown): string => {
  const k = e instanceof Error ? (e as { kind?: unknown }).kind : undefined;
  if (typeof k === "string" && k.length > 0) return k;
  return e instanceof Error && e.name !== "" ? e.name : "unknown";
};
const nearestRank95 = (vs: readonly number[]): number => {
  const s = [...vs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.ceil(s.length * 0.95) - 1] ?? 0);
};

export const runEvalSuite = async (
  suite: EvalSuite,
  provider: DecisionProvider | null,
  opts: { readonly nowMs: () => number; readonly hashRequest: (body: unknown) => string },
): Promise<EvalManifest> => {
  const manifest = (
    verdict: EvalManifest["verdict"],
    reasons: readonly string[],
    runs: readonly EvalRunRecord[],
    schemaSuccessRate: number,
    passingCases: number,
    p95LatencyMs: number,
  ): EvalManifest => ({
    suite: suite.name,
    verdict,
    reasons,
    schemaSuccessRate,
    passingCases,
    totalCases: suite.cases.length,
    p95LatencyMs,
    runs,
  });
  if (provider === null) return manifest("blocked", ["no-provider"], [], 0, 0, 0);
  const gate = suite.gate;
  const runs: EvalRunRecord[] = [];
  let revision = 0;
  let schemaSuccesses = 0;
  let passingCases = 0;
  for (const evalCase of suite.cases) {
    let passingRuns = 0;
    for (let runIndex = 0; runIndex < gate.runsPerCase; runIndex += 1) {
      revision += 1;
      const state: DecisionState = {
        revision: parseDecisionRevision(revision),
        scenario: evalCase.scenario,
        persona: evalCase.persona,
        activeContext: evalCase.activeContext,
        choices: evalCase.choices,
      };
      const started = opts.nowMs();
      let result: DecisionResult | null = null;
      const violations: string[] = [];
      try {
        result = await provider.evaluate(state);
        violations.push(...evaluateRun(evalCase, result));
      } catch (error) {
        violations.push(`error:${errorKind(error)}`);
      }
      const latencyMs = Math.max(0, opts.nowMs() - started);
      const requestHash = opts.hashRequest(createDecisionEnvelope(state, started).body);
      if (result !== null) schemaSuccesses += 1;
      if (violations.length === 0) passingRuns += 1;
      runs.push({
        caseId: evalCase.id,
        runIndex,
        ok: violations.length === 0,
        violations,
        model: result?.model ?? "",
        requestHash,
        latencyMs,
        usage: result === null ? null : result.usage,
      });
    }
    if (passingRuns >= gate.minRunsPassing) passingCases += 1;
  }
  const schemaSuccessRate = runs.length === 0 ? 0 : schemaSuccesses / runs.length;
  const p95LatencyMs = nearestRank95(runs.map((r) => r.latencyMs));
  const reasons: string[] = [];
  if (schemaSuccessRate < 1) reasons.push("schema-success<100%");
  if (passingCases < gate.minPassingCases) {
    reasons.push(`passing-cases ${passingCases}<${gate.minPassingCases}`);
  }
  if (p95LatencyMs > gate.p95Ms) reasons.push(`p95 ${p95LatencyMs}>${gate.p95Ms}`);
  const verdict = reasons.length === 0 ? "pass" : "fail";
  return manifest(verdict, reasons, runs, schemaSuccessRate, passingCases, p95LatencyMs);
};
