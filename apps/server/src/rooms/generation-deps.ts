// Task 25 dependency resolution for the one-shot choice generation:
// which provider answers (Workers AI binding in production, always a
// mock/fixture in local) and which budget ledger owns the daily grant.
// Kept apart from ./generate-choices (the orchestration) so tests inject
// fakes through injectGenerationDeps without dragging the runner.
import {
  type GenerativeProvider,
  HttpGenerativeProvider,
  jevOutboundFetch,
  MockGenerativeProvider,
  WorkersAiGenerativeProvider,
} from "@yuragoo/ai";
import { parseServerMode, type ServerBindings } from "../config";
import { CONTROL_PLANE_NAME } from "../control/ControlPlane";

export interface GenerationBudget {
  reserve(input: {
    roomId: string;
    token: string;
    kind: string;
    day: string;
  }): Promise<{ ok: boolean; reason?: string }>;
  consume(input: { token: string }): Promise<unknown>;
  release(input: { token: string }): Promise<unknown>;
}

export interface GenerationDeps {
  readonly provider: GenerativeProvider | null;
  readonly control: GenerationBudget | null;
  readonly nowMs: () => number;
  readonly timeoutMs: number;
}

export const GENERATION_TIMEOUT_MS = 10_000; // contract deadline

// Test/dev seam — resolved per run inside the room's own I/O context.
let injectedDeps: Partial<GenerationDeps> | null = null;
export const injectGenerationDeps = (deps: Partial<GenerationDeps> | null): void => {
  injectedDeps = deps;
};

// Provider selection: local mode is ALWAYS a mock/fixture (never a paid
// call); production is the Workers AI binding or fail-closed.
const defaultProvider = (env: ServerBindings): GenerativeProvider | null => {
  if (parseServerMode(env.APP_ENV) === "local") {
    const url = env.GENERATION_UPSTREAM_URL?.trim() ?? "";
    return url === ""
      ? new MockGenerativeProvider()
      : new HttpGenerativeProvider({ url, fetch: jevOutboundFetch });
  }
  return env.AI === undefined ? null : new WorkersAiGenerativeProvider(env.AI);
};

export const resolveGenerationDeps = (env: ServerBindings): GenerationDeps => {
  const ns = env.CONTROL_PLANE;
  const envControl = ns === undefined ? null : ns.get(ns.idFromName(CONTROL_PLANE_NAME));
  return {
    provider: injectedDeps?.provider !== undefined ? injectedDeps.provider : defaultProvider(env),
    control: injectedDeps?.control !== undefined ? injectedDeps.control : envControl,
    nowMs: injectedDeps?.nowMs ?? (() => Date.now()),
    timeoutMs: injectedDeps?.timeoutMs ?? GENERATION_TIMEOUT_MS,
  };
};
