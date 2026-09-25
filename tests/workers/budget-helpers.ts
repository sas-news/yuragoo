// Shared fixtures for the Task-22 budget tests. Each test pins a UNIQUE
// UTC day via the injected nowMs so budget_days rows never bleed between
// tests; only the upstream Jev fetch is stubbed — the ControlPlane is the
// real DO resolved through the env binding inside each room's own I/O
// context (an injected stub object would cross DO contexts, which workerd
// rejects).
import { env, runInDurableObject } from "cloudflare:test";
import { CONTROL_PLANE_NAME } from "../../apps/server/src/control/ControlPlane";
import {
  type DecisionJobDeps,
  injectDecisionJobDeps,
  type UpstreamFetch,
} from "../../apps/server/src/rooms/decision-jobs";
import type { ApplyResult } from "../../apps/server/src/rooms/storage";
import { LIVE_SETTINGS, must, namedRoom, NOW, type RoomStub } from "./room-helpers";

export { NOW, type RoomStub };

export const controlStub = () =>
  env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(CONTROL_PLANE_NAME));

export interface Upstream {
  sent: number;
}

// A well-formed Jev response: probabilities mirror the requested criteria
// keys exactly and the chosen id is the (joint) max, per the contract.
export const okUpstream =
  (u: Upstream): UpstreamFetch =>
  async (_input, init) => {
    u.sent += 1;
    const body = JSON.parse(String(init?.body)) as {
      questions: { attraction: { criteria: Record<string, string> } };
    };
    const ids = Object.keys(body.questions.attraction.criteria);
    const probabilities: Record<string, number> = {};
    for (const id of ids) probabilities[id] = 1 / ids.length;
    return Response.json({
      model: "jev-1.13.0",
      answers: {
        attraction: { type: "choice", choice: ids[0], confidence: 0.5, probabilities },
      },
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  };

export const statusUpstream =
  (u: Upstream, status: number, retryAfter?: string): UpstreamFetch =>
  async () => {
    u.sent += 1;
    return new Response("upstream error", {
      status,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
  };

// A long-window LIVE fixture: 300s is outside the Task 26 contract menu,
// so the sandbox flag keeps the pre-existing test timing.
export const LIVE = { ...LIVE_SETTINGS, liveSeconds: 300, devMode: true } as const;

export const liveRoom = async (label: string): Promise<RoomStub> => {
  const { stub } = namedRoom(label);
  await stub.createRoom({ settings: LIVE, playerIds: ["p1", "p2"], nowMs: NOW });
  return stub;
};

export const post = (
  stub: RoomStub,
  playerId: string,
  n: number,
  nowMs: number,
): Promise<ApplyResult> =>
  stub.apply({
    playerId,
    commandId: `post-${playerId}-${n}`,
    fingerprint: `fp-${playerId}-${n}`,
    action: { type: "post", playerId, text: `post ${n}`, nowMs },
  });

export const drive = (stub: RoomStub): Promise<void> =>
  runInDurableObject(stub, (instance) => instance.driveDecisionJobs());

export const jevLedger = async (day: string) =>
  must(
    (await controlStub().ledger(day)).find((r) => r.kind === "jev"),
    "jev ledger row",
  );

export const poll = async (fn: () => Promise<boolean>, tries = 40): Promise<boolean> => {
  for (let i = 0; i < tries; i += 1) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

// The shared per-test day pin: each test file sets `testDayMs` before any
// room activity; the injected nowMs reads it lazily.
export const testState = { dayMs: 0 };
export const useDay = (day: string): number => {
  testState.dayMs = Date.parse(`${day}T12:00:00Z`);
  return testState.dayMs;
};

// Inject job deps for a test — nowMs always pins the test day; pass only
// the fields being exercised. Omitting `control` resolves the real
// ControlPlane inside the room's own context.
export const injectDeps = (deps: Partial<DecisionJobDeps>): void => {
  injectDecisionJobDeps({ nowMs: () => testState.dayMs, ...deps });
};

export const restoreDefaultDeps = (): void => {
  injectDecisionJobDeps({ control: null });
};
