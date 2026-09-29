// One-shot lobby scenario (お題) generation (Task 44). Mirrors
// generate-choices on the shared ./generation-run plumbing, on its own
// "scenario" slot — independent of the choices slot so a host may use
// both in one lobby. Unlike choice generation the scenario field being
// empty is the expected trigger, and a solo host may generate (drafting
// the room before anyone joins). The proposal lands as scenarioGenerated
// / generationFailed and applies through a normal lobby edit.
import {
  buildScenarioPrompt,
  GenerationProviderError,
  parseScenarioText,
  scenarioJsonSchema,
} from "@yuragoo/ai";
import { latencyBucket, logEvent } from "../observability";
import { utcDay } from "../control/budgets";
import type { RoomPlayer } from "./auth-storage";
import type { GenerationDeps } from "./generation-deps";
import {
  callProvider,
  claimSlot,
  emitOutcome,
  failOutcome,
  GENERATION_RESERVE_KIND,
  type GenerationHost,
} from "./generation-run";
import { slotSpent } from "./generation-slots";
import { readPresence } from "./leases";
import { activeMembers, readLobby } from "./lobby";
import { CommandError } from "./wire";

export interface ScenarioGenRequest {
  readonly token: string; // reserve idempotency key: gen-scenario:<commandId>
  readonly lobbyRevision: number;
  readonly memberCount: number;
}

// Same free synchronous gate as the choices path, minus the
// scenario-nonempty requirement (an empty field is the point here).
export const planScenarioGeneration = (
  sql: SqlStorage,
  players: readonly RoomPlayer[],
  playerId: string,
  gameStarted: boolean,
  commandId: string,
): ScenarioGenRequest => {
  if (readPresence(sql).hostPlayerId !== playerId) {
    throw new CommandError("not-host", "only the current host may do that");
  }
  if (gameStarted) {
    throw new CommandError("bad-state", "the lobby is locked once the game starts");
  }
  if (slotSpent(sql, "scenario")) {
    throw new CommandError("generation-spent", "a scenario was already generated this game");
  }
  return {
    token: `gen-scenario:${commandId}`,
    lobbyRevision: readLobby(sql).revision,
    memberCount: activeMembers(players).length,
  };
};

const fail = (host: GenerationHost, code: string, spent: boolean, elapsedMs?: number): void =>
  failOutcome(host, {
    code,
    spent,
    message: "お題の生成に失敗しました — 手入力で続けられます",
    scope: "scenario",
    elapsedMs,
    eventCode: "scenario-gen",
  });

export const runScenarioGeneration = async (
  host: GenerationHost,
  deps: GenerationDeps,
  req: ScenarioGenRequest,
): Promise<void> => {
  if (deps.control === null || deps.provider === null) {
    fail(host, "generation-unavailable", false);
    return;
  }
  const { control, provider } = deps;
  let grant: { ok: boolean; reason?: string };
  try {
    grant = await control.reserve({
      roomId: host.roomId,
      token: req.token,
      kind: GENERATION_RESERVE_KIND,
      day: utcDay(deps.nowMs()),
    });
  } catch {
    fail(host, "generation-unavailable", false);
    return;
  }
  if (!grant.ok) {
    fail(host, `generation-${grant.reason ?? "denied"}`, false);
    return;
  }
  const verdict = claimSlot(host, deps, "scenario");
  if (verdict !== "send") {
    await control.release({ token: req.token }).catch(() => {});
    if (verdict === "spent") fail(host, "generation-spent", false);
    return;
  }
  let scenario: string | null = null;
  let code = "generation-upstream";
  const sentAt = deps.nowMs();
  try {
    const raw = await callProvider(provider, deps, {
      kind: "scenario",
      prompt: buildScenarioPrompt(req.memberCount),
      jsonSchema: scenarioJsonSchema(),
      count: 1,
    });
    try {
      scenario = parseScenarioText(raw);
    } catch {
      code = "generation-invalid";
    }
  } catch (error) {
    code =
      error instanceof GenerationProviderError && error.kind === "timeout"
        ? "generation-timeout"
        : "generation-upstream";
  }
  // The attempt was sent — consume the grant whatever landed back.
  await control.consume({ token: req.token }).catch(() => {});
  if (scenario !== null) {
    logEvent({ eventCode: "scenario-gen", latencyBucket: latencyBucket(deps.nowMs() - sentAt) });
    emitOutcome(host, "scenarioGenerated", {
      lobbyRevision: req.lobbyRevision,
      scenario,
    });
  } else {
    fail(host, code, true, deps.nowMs() - sentAt);
  }
};
