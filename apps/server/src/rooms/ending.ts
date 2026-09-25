// The ending pipeline (Task 32) and its row layer (schema.ts): one ending
// per GAME. On finish the room extracts the deterministic panel set from
// the persisted event ledger (game-core buildStory), writes the row,
// broadcasts endingReady with template copy, then spends the "post"
// generation slot for the caption upgrade. `panel` holds the serialized
// EndingStory (protocol/story); `pose` stays NULL — panels embed their
// canonical pull and blob images never leave the client.
import { buildStory, type GameOutcome, type StorySource } from "@yuragoo/game-core";
import { type EndingStory, parseEndingStory } from "@yuragoo/protocol";
import { listRoomPlayers } from "./auth-storage";
import { slotSpent } from "./generation-slots";
import { runEndingGeneration, type EndingGenHost } from "./generate-ending";
import type { GenerationDeps } from "./generation-deps";
import type { Books } from "./due";
import { readLobby } from "./lobby";
import { listEvents, maxEventSeq, recordRoomEvent } from "./storage";
import { broadcastNewEvents, type BroadcastHost } from "./wire";

type EndingRow = { panel: string | null; pose: string | null };

// Parse-fail-closed: a corrupt row degrades to "no ending" rather than a
// broken snapshot field — the room still serves the plain outcome.
export const readEnding = (sql: SqlStorage): EndingStory | null => {
  const row = sql.exec<EndingRow>("SELECT panel, pose FROM ending WHERE id = 1").toArray()[0];
  if (row === undefined || row.panel === null) return null;
  try {
    return parseEndingStory(JSON.parse(row.panel));
  } catch {
    return null;
  }
};

export const writeEnding = (sql: SqlStorage, story: EndingStory): void => {
  sql.exec(
    "INSERT OR REPLACE INTO ending (id, panel, pose) VALUES (1, ?, NULL)",
    JSON.stringify(story),
  );
};

// Panels are per-game: rematch/backToLobby wipe them with the rest of the
// game's artifacts (clearGameArtifacts) so a stale story never leaks.
export const clearEnding = (sql: SqlStorage): void => {
  sql.exec("DELETE FROM ending");
};

// Story-level template title: deterministic like the panel copy — the
// generation call may replace it, but a template-only finish must still
// carry a title (the wire schema requires one). Grapheme-safe truncation:
// Intl.Segmenter keeps combining marks and emoji sequences intact.
const titleFor = (scenario: string): string => {
  const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
  const head = [...seg.segment(scenario.trim())]
    .slice(0, 20)
    .map((s) => s.segment)
    .join("");
  return head === "" ? "ある日のいきもの" : `「${head}」`;
};

export interface EndingHost extends BroadcastHost {
  readonly sql: SqlStorage;
  txn<T>(fn: () => T): T;
  booksView(): Books | null;
  isClosed(): boolean;
}

// Assemble the extractor's input from the room's own ledgers — events carry
// seq/type/JSON payload, posts + roster + outcome come from the snapshot,
// the committed choice prefix (slot order) + scenario come from the lobby
// ledger. buildStory stays pure; all IO lives here.
const storySourceFor = (sql: SqlStorage, books: Books): StorySource => {
  const lobby = readLobby(sql);
  const outcome: GameOutcome = books.state.outcome ?? { kind: "noContest", reason: "timeout" };
  return {
    events: listEvents(sql).map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
    })),
    posts: books.state.posts.map((p) => ({
      postId: p.postId,
      playerId: p.playerId,
      text: p.text,
      seq: p.seq,
    })),
    roster: books.state.roster,
    choices: lobby.choices.slice(0, books.state.roster.length),
    scenario: lobby.scenario,
    outcome,
    winnerName: winnerNameFor(sql, outcome),
  };
};

// The winner display name for the result caption — same resolution the
// client applies (memberName): displayName else the joinOrder seat label,
// and "メンバー" once the player row itself is gone. Player ids are wire
// keys and never readable copy.
const winnerNameFor = (sql: SqlStorage, outcome: GameOutcome): string | null => {
  if (outcome.kind !== "winner") return null;
  const players = listRoomPlayers(sql);
  const at = players.findIndex((p) => p.playerId === outcome.playerId);
  if (at < 0) return "メンバー";
  const display = players[at]?.displayName?.trim();
  return display !== undefined && display !== "" ? display : `プレイヤー${at + 1}`;
};

// The finish-time ending drive, single-flight on GameRoom's drive lanes.
// Idempotent on the ending row: an evicted DO that wakes into a finished
// game resumes exactly where the durable boundary says — the row written?
// the "post" slot spent? — and never double-builds or double-spends.
export const kickEnding = async (host: EndingHost, deps: GenerationDeps): Promise<void> => {
  const books = host.booksView();
  if (host.isClosed() || books === null || books.state.phase !== "finished") return;
  const epoch = books.meta.gameEpoch;
  const existing = readEnding(host.sql);
  if (existing === null || existing.gameEpoch !== epoch) {
    // Build + persist + broadcast the template story in one commit — the
    // first endingReady frame carries generated:false so clients can page
    // immediately instead of waiting on the model.
    const story: EndingStory = {
      gameEpoch: epoch,
      outcome: books.state.outcome ?? { kind: "noContest", reason: "timeout" },
      generated: false,
      title: titleFor(readLobby(host.sql).scenario),
      panels: [...buildStory(storySourceFor(host.sql, books))],
    };
    const since = maxEventSeq(host.sql);
    let wrote = false;
    host.txn(() => {
      const cur = host.booksView();
      if (
        host.isClosed() ||
        cur === null ||
        cur.state.phase !== "finished" ||
        cur.meta.gameEpoch !== epoch
      ) {
        return;
      }
      writeEnding(host.sql, story);
      recordRoomEvent(host.sql, "endingReady", story);
      wrote = true;
    });
    if (wrote) broadcastNewEvents(host, since, books.state);
  }
  // Generation half: only while the "post" slot is unspent — a spent row
  // means an attempt already durably left (or the upgrade landed), and
  // at-most-once wins over a possibly-lost result.
  if (!slotSpent(host.sql, "post")) {
    await runEndingGeneration(host as EndingHost & EndingGenHost, deps, epoch);
  }
};
