// One-shot lobby choice generation (Task 25). The WS command only
// validates + captures the request (dispatch.ts); this module owns the
// async attempt, kicked via GameRoom.startChoiceGeneration:
//
//   ControlPlane.reserve (kind="generation")
//     -> send boundary: insert the "pre" slot row in the same txn that
//        re-verifies the lobby is still live and unspent (at-most-once)
//     -> provider.generate under a 10s deadline (never auto-retried)
//     -> consume the grant whatever the outcome (a failed send still
//        spent it — Task 22 honest accounting)
//     -> persist + broadcast choicesGenerated / generationFailed
//
// The proposal NEVER writes lobby fields: the event carries the labels
// and the captured lobbyRevision, and the host applies them through a
// normal updateLobbyContent on the current revision. Results arriving
// after room close or game start are discarded.
import {
  buildChoicePrompt,
  choiceLabelsJsonSchema,
  GenerationProviderError,
  type GenerativeProvider,
  parseChoiceLabels,
} from "@yuragoo/ai";
import { countGraphemes } from "@yuragoo/protocol";
import { latencyBucket, logEvent } from "../observability";
import { utcDay } from "../control/budgets";
import type { RoomPlayer } from "./auth-storage";
import type { Books } from "./due";
import type { GenerationDeps } from "./generation-deps";
import { slotSpent } from "./generation-slots";
import { readPresence } from "./leases";
import { activeMembers, readLobby } from "./lobby";
import { maxEventSeq, recordRoomEvent } from "./storage";
import { broadcastNewEvents, type BroadcastHost, CommandError } from "./wire";

export const GENERATION_RESERVE_KIND = "generation";

// Everything the async attempt needs, captured inside the command's
// commit transaction (the server, not the payload, is authoritative).
export interface ChoiceGenRequest {
  readonly token: string; // reserve idempotency key: gen:<commandId>
  readonly lobbyRevision: number;
  readonly scenario: string;
  readonly memberCount: number;
}

export interface ChoiceGenHost extends BroadcastHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  isClosed(): boolean;
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
  const members = activeMembers(players);
  if (members.length < 2) {
    throw new CommandError("lobby-too-few", "at least two members are required to generate");
  }
  const lobby = readLobby(sql);
  if (countGraphemes(lobby.scenario.trim()) === 0) {
    throw new CommandError("lobby-scenario-empty", "the scenario is empty");
  }
  return {
    token: `gen:${commandId}`,
    lobbyRevision: lobby.revision,
    scenario: lobby.scenario,
    memberCount: members.length,
  };
};

// Persist + broadcast a generation outcome — only while the lobby is
// still live. A room that closed or started its game mid-flight gets no
// row at all: the result is discarded, never half-applied.
const emitOutcome = (
  host: ChoiceGenHost,
  type: "choicesGenerated" | "generationFailed",
  payload: unknown,
): void => {
  try {
    const since = maxEventSeq(host.sql);
    let wrote = false;
    host.txn(() => {
      if (host.isClosed() || host.booksView() !== null) return;
      recordRoomEvent(host.sql, type, payload);
      wrote = true;
    });
    if (wrote) broadcastNewEvents(host, since, null);
  } catch {
    // Storage already wiped — the late result is discarded by design.
  }
};

const fail = (host: ChoiceGenHost, code: string, slotSpent: boolean, elapsedMs?: number): void => {
  // Structured ops log alongside the room event — codes only, never the
  // scenario text or room/player ids.
  logEvent({
    eventCode: "choice-gen",
    errorKind: code,
    latencyBucket: elapsedMs === undefined ? undefined : latencyBucket(elapsedMs),
  });
  emitOutcome(host, "generationFailed", {
    code,
    message: "選択肢の生成に失敗しました — 手入力で続けられます",
    slotSpent,
  });
};

// Hard deadline around the provider call: the race settles even when an
// implementation ignores the AbortSignal (e.g. the AI binding).
const callProvider = async (
  provider: GenerativeProvider,
  deps: GenerationDeps,
  req: ChoiceGenRequest,
): Promise<unknown> => {
  const controller = new AbortController();
  const request = {
    prompt: buildChoicePrompt(req.scenario, req.memberCount),
    jsonSchema: choiceLabelsJsonSchema(req.memberCount),
    count: req.memberCount,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      reject(new GenerationProviderError("timeout", "generation exceeded the deadline"));
    }, deps.timeoutMs);
  });
  try {
    return await Promise.race([provider.generate(request, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const runChoiceGeneration = async (
  host: ChoiceGenHost,
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
  // The durable send boundary: the slot row and the lobby-still-live
  // re-check commit atomically — exactly once, or the grant is released.
  let verdict: "send" | "spent" | "late";
  try {
    verdict = host.txn(() => {
      if (host.isClosed() || host.booksView() !== null) return "late" as const;
      if (slotSpent(host.sql, "pre")) return "spent" as const;
      host.sql.exec(
        "INSERT INTO generation_slots (slot, spent_at_ms) VALUES ('pre', ?)",
        deps.nowMs(),
      );
      return "send" as const;
    });
  } catch {
    verdict = "late";
  }
  if (verdict !== "send") {
    await control.release({ token: req.token }).catch(() => {});
    if (verdict === "spent") fail(host, "generation-spent", false);
    return;
  }
  let labels: string[] | null = null;
  let code = "generation-upstream";
  const sentAt = deps.nowMs();
  try {
    const raw = await callProvider(provider, deps, req);
    try {
      labels = parseChoiceLabels(raw, req.memberCount);
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
      memberCount: req.memberCount,
      labels,
    });
  } else {
    fail(host, code, true, deps.nowMs() - sentAt);
  }
};
