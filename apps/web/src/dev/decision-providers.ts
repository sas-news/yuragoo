// DecisionLab provider seam: the seeded mock provider and the loopback dev
// gateway client. No secrets live here — the gateway URL is the only endpoint
// the live path ever sees.
import { type MockDecisionFixture, MockDecisionProvider } from "@yuragoo/ai";
import type { DecisionResult, DecisionState } from "@yuragoo/protocol";
import { LAB_CHOICES } from "./decision-flow";

export const LIVE_TIMEOUT_MS = 8000;

export type LabSource = "mock" | "live";
export interface LabAttempts {
  readonly dailyAttempts: number;
  readonly sessionAttempts: number;
}
export interface LabEvaluation {
  readonly result: DecisionResult;
  readonly source: LabSource;
  readonly attempts?: LabAttempts;
}
export type LabEvaluate = (state: DecisionState) => Promise<LabEvaluation>;

export class LabEvaluationError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "LabEvaluationError";
    this.kind = kind;
  }
}

const FIXTURES: readonly MockDecisionFixture[] = [
  ...LAB_CHOICES.map((choice) => ({
    key: `favor-${choice.id}`,
    weights: Object.fromEntries(
      LAB_CHOICES.map((c) => [c.id, c.id === choice.id ? 0.7 : 0.1] as const),
    ),
  })),
  // 葛藤 fixture: a knife-edge a/b race so the lab can stage the conflict dwell.
  { key: "contest", weights: { a: 0.45, b: 0.45, c: 0.05, d: 0.05 } },
];

export const createMockEvaluate = (): LabEvaluate => {
  const provider = new MockDecisionProvider({ seed: 42, fixtures: FIXTURES });
  return async (state) => ({ result: await provider.evaluate(state), source: "mock" });
};

const field = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;

const parseAttempts = (raw: unknown): LabAttempts | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const daily = Reflect.get(raw, "dailyAttempts");
  const session = Reflect.get(raw, "sessionAttempts");
  return typeof daily === "number" && typeof session === "number"
    ? { dailyAttempts: daily, sessionAttempts: session }
    : undefined;
};

export const createLiveEvaluate = (gatewayUrl: string, sessionId: string): LabEvaluate => {
  const base = gatewayUrl.replace(/\/+$/, "");
  return async (state) => {
    let response: Response;
    try {
      response = await fetch(`${base}/api/dev/jev/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, state }),
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      throw new LabEvaluationError(
        name === "TimeoutError" ? "timeout" : "unreachable",
        name === "TimeoutError" ? "gateway request timed out" : "gateway unreachable",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errorField = field(body, "error");
      const kind = typeof errorField === "string" ? errorField : `http-${response.status}`;
      throw new LabEvaluationError(kind, `gateway responded ${response.status}`);
    }
    const result = field(body, "result");
    if (!Array.isArray(field(result, "distribution"))) {
      throw new LabEvaluationError("invalid-response", "gateway response missing distribution");
    }
    const attempts = parseAttempts(field(body, "attempts"));
    return {
      result: result as DecisionResult,
      source: "live",
      ...(attempts !== undefined ? { attempts } : {}),
    };
  };
};

// lab-<8 base36> from crypto — never Math.random, matches the gateway pattern.
export const createSessionId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) suffix += (byte % 36).toString(36);
  return `lab-${suffix}`;
};
