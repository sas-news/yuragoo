// Post-game ending-caption generation (Task 31): one attempt per game
// that upgrades the template story's captions in place, under waitUntil.
//
//   ControlPlane.reserve (kind="generation", token per room+epoch)
//     -> send boundary: "post" slot row + gates in one txn (still
//        finished, same epoch, ending row present, slot unspent)
//     -> provider.generate under the deadline (never auto-retried)
//     -> consume the grant whatever landed (honest Task 22 accounting)
//     -> apply txn: re-verify the same gates, re-read the row, write the
//        generated story + endingReady in one commit
//
// Unlike the lobby runner this emits NO failure event: panels already
// carry readable template prose, and generated captions either fully
// replace them or never land — a half-generated story reads like two
// authors fighting, so the template is the once-only fallback and a
// rejected result is only logged.
import {
  buildEndingPrompt,
  type EndingGenerationInput,
  endingJsonSchema,
  type EndingPanelInput,
  GenerationProviderError,
  type GenerativeProvider,
  parseEndingCaptions,
} from "@yuragoo/ai";
import type { EndingStory } from "@yuragoo/protocol";
import { utcDay } from "../control/budgets";
import type { Books } from "./due";
import { readEnding, writeEnding } from "./ending";
import { GENERATION_RESERVE_KIND } from "./generate-choices";
import type { GenerationDeps } from "./generation-deps";
import { slotSpent } from "./generation-slots";
import { readLobby } from "./lobby";
import { maxEventSeq, recordRoomEvent, writeMeta } from "./storage";
import { broadcastNewEvents, type BroadcastHost } from "./wire";

// The room surface the runner needs (GameRoom satisfies it). setBooks
// exists because recordRoomEvent bumps the persisted state_revision —
// without the re-sync the next commitAction publish would collide on
// events.seq (commits.ts' close path does the same swap).
export interface EndingGenHost extends BroadcastHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  setBooks(books: Books | null): void;
  isClosed(): boolean;
}

// No stream event for rejections — the template captions stand silently.
const fail = (code: string): void => {
  console.log(`[ending-gen] ${code}`);
};

// The gates run identically at the send boundary and again inside the
// apply txn: only the SAME finished game (same epoch) that still owns a
// non-generated ending row may receive this attempt's prose.
const stillSameFinishedGame = (host: EndingGenHost, gameEpoch: number): boolean => {
  const books = host.booksView();
  return (
    !host.isClosed() &&
    books !== null &&
    books.state.phase === "finished" &&
    books.meta.gameEpoch === gameEpoch
  );
};

const endingInput = (sql: SqlStorage, story: EndingStory): EndingGenerationInput => {
  const lobby = readLobby(sql);
  // The committed prefix rides canonical slot i (room-arena contract):
  // the winner's label is a pre-resolved fact the model may quote but
  // never change.
  const committed = lobby.choices.slice(0, lobby.committedCount);
  const outcome = story.outcome;
  const label = outcome.kind === "winner" ? (committed[outcome.slot]?.label ?? "").trim() : "";
  return {
    scenario: lobby.scenario,
    outcome: {
      kind: outcome.kind,
      winnerLabel: label === "" ? null : label,
      noContestReason: outcome.kind === "noContest" ? outcome.reason : null,
    },
    panels: story.panels.map(
      (p): EndingPanelInput => ({ kind: p.kind, eventId: p.eventId, quotes: p.quotes }),
    ),
  };
};

// The durable send boundary: the "post" slot row commits atomically with
// every re-check — spendGenerationSlot refuses finished games, so the
// row is inserted directly like the lobby runner inserts "pre". The
// captured model input rides the return value: it is built inside the
// same atomic step that decided the send.
const prepareSend = (
  host: EndingGenHost,
  deps: GenerationDeps,
  gameEpoch: number,
): EndingGenerationInput | "late" | "spent" => {
  try {
    return host.txn(() => {
      if (!stillSameFinishedGame(host, gameEpoch)) return "late" as const;
      const story = readEnding(host.sql);
      if (story === null || story.gameEpoch !== gameEpoch || story.generated) {
        return "late" as const;
      }
      if (slotSpent(host.sql, "post")) return "spent" as const;
      host.sql.exec(
        "INSERT INTO generation_slots (slot, spent_at_ms) VALUES ('post', ?)",
        deps.nowMs(),
      );
      // Keep the human-visible counter in lockstep with the slot ledger
      // (spendGenerationSlot does the same pair for pre-finish spends).
      const books = host.booksView();
      if (books !== null) {
        const meta = { ...books.meta, generationAttempts: books.meta.generationAttempts + 1 };
        writeMeta(host.sql, meta);
        host.setBooks({ meta, state: books.state });
      }
      return endingInput(host.sql, story);
    });
  } catch {
    return "late"; // storage already torn down
  }
};

// Hard deadline around the provider call: the race settles even when an
// implementation ignores the AbortSignal (the AI binding takes none).
const callProvider = async (
  provider: GenerativeProvider,
  deps: GenerationDeps,
  input: EndingGenerationInput,
): Promise<unknown> => {
  const controller = new AbortController();
  const request = {
    prompt: buildEndingPrompt(input),
    jsonSchema: endingJsonSchema(input.panels.map((p) => p.eventId)),
    count: input.panels.length,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      reject(new GenerationProviderError("timeout", "ending generation exceeded the deadline"));
    }, deps.timeoutMs);
  });
  try {
    return await Promise.race([provider.generate(request, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const runEndingGeneration = async (
  host: EndingGenHost,
  deps: GenerationDeps,
  gameEpoch: number,
): Promise<void> => {
  if (deps.control === null || deps.provider === null) {
    fail("generation-unavailable");
    return;
  }
  const { control, provider } = deps;
  // Reservations are keyed by a GLOBAL token primary key (a replay grants
  // regardless of room), so the room id rides the token — a same-epoch
  // game in another room can never replay or consume this grant.
  const token = `${host.roomId}:end:e${gameEpoch}`;
  let grant: { ok: boolean; reason?: string };
  try {
    grant = await control.reserve({
      roomId: host.roomId,
      token,
      kind: GENERATION_RESERVE_KIND,
      day: utcDay(deps.nowMs()),
    });
  } catch {
    fail("generation-unavailable");
    return;
  }
  if (!grant.ok) {
    fail(`generation-${grant.reason ?? "denied"}`);
    return;
  }
  const prepared = prepareSend(host, deps, gameEpoch);
  if (typeof prepared === "string") {
    await control.release({ token }).catch(() => {});
    fail(`generation-${prepared}`);
    return;
  }
  const input = prepared;
  let title: string | null = null;
  let captions: ReadonlyMap<number, string> | null = null;
  let code = "generation-upstream";
  try {
    const raw = await callProvider(provider, deps, input);
    try {
      const parsed = parseEndingCaptions(
        raw,
        input.panels.map((p) => p.eventId),
      );
      title = parsed.title;
      captions = parsed.captions;
    } catch {
      code = "generation-invalid";
    }
  } catch (error) {
    code =
      error instanceof GenerationProviderError && error.kind === "timeout"
        ? "generation-timeout"
        : "generation-upstream";
  }
  // The attempt reached the wire — consume the grant whatever landed.
  await control.consume({ token }).catch(() => {});
  if (title === null || captions === null) {
    fail(code); // the template story stands — the once-only fallback
    return;
  }
  // const copies carry the narrowed type into the txn closure.
  const storyTitle = title;
  const storyCaptions = captions;
  const since = maxEventSeq(host.sql);
  let wrote = false;
  try {
    host.txn(() => {
      if (!stillSameFinishedGame(host, gameEpoch)) return;
      const story = readEnding(host.sql);
      if (story === null || story.gameEpoch !== gameEpoch || story.generated) return;
      // Coverage is parse-guaranteed — the get() fallback only satisfies
      // strict-null typing, it never triggers. The generated title lands
      // on the story; panels keep their per-page template titles.
      const panels = story.panels.map((p) => ({
        ...p,
        caption: storyCaptions.get(p.eventId) ?? p.caption,
      }));
      const updated: EndingStory = { ...story, generated: true, title: storyTitle, panels };
      writeEnding(host.sql, updated);
      const seq = recordRoomEvent(host.sql, "endingReady", updated);
      // state_revision moved under the books — re-sync the in-memory
      // copy or the next game commit publishes onto a taken seq.
      const books = host.booksView();
      if (books !== null) {
        host.setBooks({ meta: { ...books.meta, stateRevision: seq }, state: books.state });
      }
      wrote = true;
    });
    if (wrote) broadcastNewEvents(host, since, null);
  } catch {
    // Storage torn down mid-flight — the template row (or nothing)
    // stands; late prose never lands on a dead room.
  }
};
