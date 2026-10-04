// Shared async-attempt plumbing for lobby-phase AI generation (Task 25/44).
// The WS command only validates + captures the request; the runner then:
//
//   ControlPlane.reserve (kind="generation")
//     -> send boundary: the slot row inserts in the same txn that
//        re-verifies the lobby is still live (at-most-once)
//     -> provider.generate under a 10s deadline (never auto-retried)
//     -> consume the grant whatever the outcome (a failed send still
//        spent it — Task 22 honest accounting)
//     -> persist + broadcast the proposal / failure event
//
// Proposals NEVER write lobby fields: the event carries the payload and
// the captured lobbyRevision, and the host applies through a normal
// updateLobbyContent on the current revision. Results arriving after room
// close or game start are discarded.
import {
  GenerationProviderError,
  type GenerationRequest,
  type GenerativeProvider,
} from "@yuragoo/ai";
import { latencyBucket, logEvent } from "../observability";
import type { Books } from "./due";
import type { GenerationDeps } from "./generation-deps";
import { maxEventSeq, recordRoomEvent } from "./storage";
import { broadcastNewEvents, type BroadcastHost } from "./wire";

export const GENERATION_RESERVE_KIND = "generation";

export interface GenerationHost extends BroadcastHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  isClosed(): boolean;
}

// Persist + broadcast a generation outcome — only while the lobby is
// still live. A room that closed or started its game mid-flight gets no
// row at all: the result is discarded, never half-applied.
export const emitOutcome = (
  host: GenerationHost,
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

export interface FailOutcomeInput {
  readonly code: string;
  readonly spent: boolean;
  readonly message: string;
  readonly elapsedMs?: number | undefined;
  readonly eventCode?: string | undefined;
}

export const failOutcome = (host: GenerationHost, o: FailOutcomeInput): void => {
  // Structured ops log alongside the room event — codes only, never the
  // prompt text or room/player ids.
  logEvent({
    eventCode: o.eventCode ?? "choice-gen",
    errorKind: o.code,
    latencyBucket: o.elapsedMs === undefined ? undefined : latencyBucket(o.elapsedMs),
  });
  emitOutcome(host, "generationFailed", {
    code: o.code,
    message: o.message,
    slotSpent: o.spent,
  });
};

// Hard deadline around the provider call: the race settles even when an
// implementation ignores the AbortSignal (e.g. the AI binding).
export const callProvider = async (
  provider: GenerativeProvider,
  deps: GenerationDeps,
  request: GenerationRequest,
): Promise<unknown> => {
  const controller = new AbortController();
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

// Re-generation is allowed: the "pre" slot row now records only that a
// proposal landed at least once (the lobby's generationSpent flag). The
// gate against concurrent sends is a separate in-flight marker row —
// inserted in the same txn that re-verifies the lobby is still live and
// deleted by whichever outcome lands, so a second click during a send
// gets "busy" instead of a second upstream call.
const FLIGHT_SLOT = "pre-flight";

export const claimFlight = (
  host: GenerationHost,
  deps: GenerationDeps,
): "send" | "busy" | "late" => {
  try {
    return host.txn(() => {
      if (host.isClosed() || host.booksView() !== null) return "late" as const;
      const inFlight = host.sql
        .exec("SELECT slot FROM generation_slots WHERE slot = ?", FLIGHT_SLOT)
        .toArray();
      if (inFlight.length > 0) return "busy" as const;
      host.sql.exec(
        "INSERT INTO generation_slots (slot, spent_at_ms) VALUES (?, ?)",
        FLIGHT_SLOT,
        deps.nowMs(),
      );
      return "send" as const;
    });
  } catch {
    return "late";
  }
};

export const releaseFlight = (host: GenerationHost): void => {
  try {
    host.txn(() => {
      host.sql.exec("DELETE FROM generation_slots WHERE slot = ?", FLIGHT_SLOT);
    });
  } catch {
    // Storage torn down mid-flight — the marker dies with the room anyway.
  }
};

// Success records the one-shot flag: INSERT OR IGNORE keeps the first
// landing's timestamp across re-generations.
export const markPreSpent = (host: GenerationHost, deps: GenerationDeps): void => {
  try {
    host.txn(() => {
      host.sql.exec(
        "INSERT OR IGNORE INTO generation_slots (slot, spent_at_ms) VALUES ('pre', ?)",
        deps.nowMs(),
      );
    });
  } catch {
    // Storage torn down mid-flight — the flag dies with the room anyway.
  }
};
