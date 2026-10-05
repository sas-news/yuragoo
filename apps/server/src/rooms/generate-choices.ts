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
import { countGraphemes, LOBBY_SEAT_COUNT, type RoomLanguage } from "@yuragoo/protocol";
import { latencyBucket, logEvent } from "../observability";
import { utcDay } from "../control/budgets";
import type { RoomPlayer } from "./auth-storage";
import type { GenerationDeps } from "./generation-deps";
import {
  callProvider,
  claimFlight,
  emitOutcome,
  failOutcome,
  GENERATION_RESERVE_KIND,
  type GenerationHost,
  markPreSpent,
  releaseFlight,
} from "./generation-run";
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
  // Shared-text language the labels are generated in — captured from the
  // lobby settings inside the same commit that accepted the command.
  readonly language: RoomLanguage;
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
  // Re-generation is allowed — the daily quota is the real budget gate,
  // and the in-flight marker in the runner stops concurrent sends.
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
    language: lobby.settings.language,
  };
};

// Failure copy rides the room language — the toast lands on the requester's
// screen but the phrasing matches what the room is playing in.
const FAIL_MESSAGE: Record<RoomLanguage, string> = {
  ja: "選択肢の生成に失敗しました — もう一度試すか手入力で続けられます",
  en: "Choice generation failed — try again or type them in yourself",
};

const fail = (
  host: GenerationHost,
  lang: RoomLanguage,
  code: string,
  spent: boolean,
  elapsedMs?: number,
  message?: string,
): void => failOutcome(host, { code, spent, message: message ?? FAIL_MESSAGE[lang], elapsedMs });

export const runChoiceGeneration = async (
  host: GenerationHost,
  deps: GenerationDeps,
  req: ChoiceGenRequest,
): Promise<void> => {
  const lang = req.language;
  if (deps.control === null || deps.provider === null) {
    fail(host, lang, "generation-unavailable", false);
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
    fail(host, lang, "generation-unavailable", false);
    return;
  }
  if (!grant.ok) {
    fail(host, lang, `generation-${grant.reason ?? "denied"}`, false);
    return;
  }
  const verdict = claimFlight(host, deps);
  if (verdict !== "send") {
    await control.release({ token: req.token }).catch(() => {});
    if (verdict === "busy") {
      const busy =
        lang === "en"
          ? "Generation is running — give it a moment"
          : "いま生成中です — 少し待ってください";
      fail(host, lang, "generation-busy", false, undefined, busy);
    }
    return;
  }
  let labels: string[] | null = null;
  let code = "generation-upstream";
  const sentAt = deps.nowMs();
  try {
    const raw = await callProvider(provider, deps, {
      kind: "choices",
      prompt: buildChoicePrompt(req.scenario, req.labelCount, lang),
      jsonSchema: choiceLabelsJsonSchema(req.labelCount),
      count: req.labelCount,
    });
    try {
      labels = parseChoiceLabels(raw, req.labelCount);
    } catch (error) {
      // Tag the parse-failure reason so the surfaced code doubles as the
      // diagnosis (ops log picks it up via errorKind too).
      code = `generation-invalid:${invalidTag(error)}`;
    }
  } catch (error) {
    code =
      error instanceof GenerationProviderError && error.kind === "timeout"
        ? "generation-timeout"
        : "generation-upstream";
  }
  // The attempt was sent — consume the grant whatever landed back. A
  // failure also releases the per-room slot: the quota spend is real,
  // but a flaky provider must not brick generation for this room.
  await control.consume({ token: req.token }).catch(() => {});
  if (labels !== null) {
    logEvent({ eventCode: "choice-gen", latencyBucket: latencyBucket(deps.nowMs() - sentAt) });
    markPreSpent(host, deps);
    releaseFlight(host);
    emitOutcome(host, "choicesGenerated", {
      lobbyRevision: req.lobbyRevision,
      memberCount: req.labelCount,
      labels,
    });
  } else {
    releaseFlight(host);
    fail(host, lang, code, false, deps.nowMs() - sentAt);
  }
};

// Map the parser's stable rejection messages to a short code suffix so a
// failed generation tells us WHICH contract check the provider broke.
const invalidTag = (error: unknown): string => {
  const msg = error instanceof Error ? error.message : "";
  if (msg.includes("not JSON")) return "json";
  // "expected exactly N choices, got M" -> count-MofN — the actual count
  // the model returned decides the next fix (short vs malformed).
  const cm = /expected exactly (\d+) choices, got (\d+)/.exec(msg);
  if (cm !== null) return `count-${cm[2]}of${cm[1]}`;
  if (msg.includes("not an array")) return "noarr";
  if (msg.includes("not a string")) return "type";
  if (msg.includes("empty")) return "empty";
  if (msg.includes("graphemes")) return "long";
  if (msg.includes("distinct")) return "dupe";
  return "unknown";
};
