// One-shot lobby choice generation (Task 25). The WS command only
// validates + captures the request (dispatch.ts); the async runner and
// the shared send-boundary/slot plumbing live in ./generation-run — the
// proposal arrives as a choicesGenerated / generationFailed event.
import {
  buildChoicePrompt,
  choiceLabelsJsonSchema,
  GenerationProviderError,
  parseChoiceLabels,
} from "@yuragoo/ai";
import { countGraphemes, LOBBY_SEAT_COUNT } from "@yuragoo/protocol";
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

// Everything the async attempt needs, captured inside the command's
// commit transaction (the server, not the payload, is authoritative).
export interface ChoiceGenRequest {
  readonly token: string; // reserve idempotency key: gen:<commandId>
  readonly lobbyRevision: number;
  readonly scenario: string;
  readonly labelCount: number;
}

// The synchronous gate the command dispatch runs before accepting the
// request — every check here is free: the slot and the daily grant are
// only touched by the async runner AFTER the command commits.
export const planChoiceGeneration = (
  sql: SqlStorage,
  players: readonly RoomPlayer[],
  playerId: string,
  gameStarted: boolean,
  commandId: string,
): ChoiceGenRequest => {
  if (readPresence(sql).hostPlayerId !== playerId) {
    throw new CommandError("not-host", "only the current host may do that");
  }
  if (gameStarted) {
    throw new CommandError("bad-state", "the lobby is locked once the game starts");
  }
  if (slotSpent(sql, "pre")) {
    throw new CommandError("generation-spent", "choices were already generated this game");
  }
  const lobby = readLobby(sql);
  if (countGraphemes(lobby.scenario.trim()) === 0) {
    throw new CommandError("lobby-scenario-empty", "the scenario is empty");
  }
  // A solo host preps the whole seat sheet (labels land as orphan drafts
  // that activate as members join); otherwise fill the visible rows.
  const members = activeMembers(players);
  const labelCount =
    members.length === 1 ? LOBBY_SEAT_COUNT : Math.max(lobby.choices.length, members.length);
  return {
    token: `gen:${commandId}`,
    lobbyRevision: lobby.revision,
    scenario: lobby.scenario,
    labelCount,
  };
};

const fail = (host: GenerationHost, code: string, spent: boolean, elapsedMs?: number): void =>
  failOutcome(host, {
    code,
    spent,
    message: "選択肢の生成に失敗しました — 手入力で続けられます",
    elapsedMs,
  });

export const runChoiceGeneration = async (
  host: GenerationHost,
  deps: GenerationDeps,
  req: ChoiceGenRequest,
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
  const verdict = claimSlot(host, deps, "pre");
  if (verdict !== "send") {
    await control.release({ token: req.token }).catch(() => {});
    if (verdict === "spent") fail(host, "generation-spent", false);
    return;
  }
  let labels: string[] | null = null;
  let code = "generation-upstream";
  const sentAt = deps.nowMs();
  try {
    const raw = await callProvider(provider, deps, {
      kind: "choices",
      prompt: buildChoicePrompt(req.scenario, req.labelCount),
      jsonSchema: choiceLabelsJsonSchema(req.labelCount),
      count: req.labelCount,
    });
    try {
      labels = parseChoiceLabels(raw, req.labelCount);
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
  if (labels !== null) {
    logEvent({ eventCode: "choice-gen", latencyBucket: latencyBucket(deps.nowMs() - sentAt) });
    emitOutcome(host, "choicesGenerated", {
      lobbyRevision: req.lobbyRevision,
      memberCount: req.labelCount,
      labels,
    });
  } else {
    fail(host, code, true, deps.nowMs() - sentAt);
  }
};
