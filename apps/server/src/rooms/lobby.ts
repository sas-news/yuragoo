// The room's shared lobby ledger (Task 24): scenario text, per-seat
// choice drafts and ready flags, persisted in the `lobby` table so an
// evicted DO recovers the host's in-progress setup exactly.
//
// choiceIds are server-assigned at growth (`c0`, `c1`, … append-only) and
// stable across edits/member-count changes. Shrinking never deletes rows:
// the tail becomes orphan drafts that re-activate when the count regrows.
// startGame commits only the first `memberCount` rows (committed_count).
// lobbyChanged writes only on real change — a no-op never bumps revision.
import {
  CHOICE_LABEL_MAX_GRAPHEMES,
  countGraphemes,
  labelKey,
  LOBBY_SEAT_COUNT,
  type LobbyChoice,
  type LobbyState,
  SCENARIO_MAX_GRAPHEMES,
  type UpdateLobbyContentPayload,
} from "@yuragoo/protocol";
import type { RoomPlayer } from "./auth-storage";
import { slotSpent } from "./generation-slots";
import { lobbySettingsView, readLobbyPatch } from "./settings";
import { recordRoomEvent } from "./storage";
import { CommandError } from "./wire";

type LobbySqlRow = {
  revision: number;
  scenario: string;
  choices: string;
  ready: string;
  committed_count: number;
};

const stringArray = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const choiceArray = (raw: string): LobbyChoice[] => {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is LobbyChoice =>
        x !== null &&
        typeof x === "object" &&
        typeof (x as LobbyChoice).choiceId === "string" &&
        typeof (x as LobbyChoice).label === "string",
    );
  } catch {
    return [];
  }
};

export const readLobby = (sql: SqlStorage): LobbyState => {
  const row = sql
    .exec<LobbySqlRow>(
      "SELECT revision, scenario, choices, ready, committed_count FROM lobby WHERE id = 1",
    )
    .toArray()[0];
  // generationSpent + settings are derived views (Task 25/26).
  return {
    revision: row?.revision ?? 0,
    scenario: row?.scenario ?? "",
    choices: choiceArray(row?.choices ?? "[]"),
    ready: stringArray(row?.ready ?? "[]"),
    committedCount: row?.committed_count ?? 0,
    generationSpent: slotSpent(sql, "pre"),
    settings: lobbySettingsView(readLobbyPatch(sql)),
  };
};

// Persist + publish in one step inside transactionSync. Exported for the
// Task 26 settings-patch writer in ./lobby-settings.
export const commitLobby = (sql: SqlStorage, state: LobbyState): number => {
  sql.exec(
    "INSERT OR REPLACE INTO lobby (id, revision, scenario, choices, ready, committed_count) " +
      "VALUES (1, ?, ?, ?, ?, ?)",
    state.revision,
    state.scenario,
    JSON.stringify(state.choices),
    JSON.stringify(state.ready),
    state.committedCount,
  );
  return recordRoomEvent(sql, "lobbyChanged", state);
};

// Members that count for the lobby: lobbyWaiting joiners (mid-game) are
// room members but never enter the start gate or the choice count.
export const activeMembers = (players: readonly RoomPlayer[]): RoomPlayer[] =>
  players.filter((p) => !p.lobbyWaiting);

// For backToLobby: the seat count AFTER the lobbyWaiting flag flip.
export const activeMemberCount = (sql: SqlStorage): number =>
  sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_players WHERE lobby_waiting = 0").one().n;

// Membership hooks — called inside the join/leave transactions so the
// ledger, the member row and the event rows commit together.
export const onMemberJoined = (
  sql: SqlStorage,
  view: {
    readonly playerId: string;
    readonly joinOrder: number;
    readonly displayName: string | null;
    readonly lobbyWaiting: boolean;
    readonly platform: string;
    // Optional like the wire field — undefined drops the key entirely.
    readonly avatarUrl?: string | undefined;
  },
  gameExists: boolean,
): void => {
  recordRoomEvent(sql, "memberJoined", { ...view, connected: false });
  if (gameExists || view.lobbyWaiting) return;
  const lobby = readLobby(sql);
  const count = activeMemberCount(sql);
  if (lobby.choices.length >= count) return; // orphan re-activation: no payload change
  const choices = [...lobby.choices];
  while (choices.length < count) choices.push({ choiceId: `c${choices.length}`, label: "" });
  commitLobby(sql, { ...lobby, revision: lobby.revision + 1, choices });
};

export const onMemberLeft = (sql: SqlStorage, playerId: string, gameExists: boolean): void => {
  recordRoomEvent(sql, "memberLeft", { playerId });
  if (gameExists) return;
  const lobby = readLobby(sql);
  if (!lobby.ready.includes(playerId)) return; // orphan boundary is derived client-side
  commitLobby(sql, {
    ...lobby,
    revision: lobby.revision + 1,
    ready: lobby.ready.filter((id) => id !== playerId),
  });
};

// Host edit path: expectedLobbyRevision is the optimistic lock — a stale
// base rejects the whole patch and writes nothing (the client keeps its
// local drafts and retries on the new revision).
export const applyLobbyContent = (
  sql: SqlStorage,
  patch: UpdateLobbyContentPayload,
): LobbyState => {
  const lobby = readLobby(sql);
  if (patch.expectedLobbyRevision !== lobby.revision) {
    throw new CommandError(
      "lobby-revision-conflict",
      `lobby is at revision ${lobby.revision}; resync before editing`,
    );
  }
  let scenario = lobby.scenario;
  if (patch.scenario !== undefined) {
    if (countGraphemes(patch.scenario) > SCENARIO_MAX_GRAPHEMES) {
      throw new CommandError("too-long", `scenario exceeds ${SCENARIO_MAX_GRAPHEMES} graphemes`);
    }
    scenario = patch.scenario;
  }
  let choices = lobby.choices;
  if (patch.choices !== undefined) {
    const next = lobby.choices.map((c) => ({ ...c }));
    const index = new Map(next.map((c, i) => [c.choiceId, i] as const));
    for (const edit of patch.choices) {
      let at = index.get(edit.choiceId);
      if (at === undefined) {
        // Prep append: only the next sequential id may grow a seat row.
        if (edit.choiceId !== `c${next.length}` || next.length >= LOBBY_SEAT_COUNT) {
          throw new CommandError("unknown-choice", `no lobby choice ${edit.choiceId}`);
        }
        at = next.length;
        next.push({ choiceId: edit.choiceId, label: "" });
        index.set(edit.choiceId, at);
      }
      if (countGraphemes(edit.label) > CHOICE_LABEL_MAX_GRAPHEMES) {
        throw new CommandError(
          "too-long",
          `choice exceeds ${CHOICE_LABEL_MAX_GRAPHEMES} graphemes`,
        );
      }
      next[at] = { choiceId: edit.choiceId, label: edit.label };
    }
    choices = next;
  }
  const state = { ...lobby, revision: lobby.revision + 1, scenario, choices };
  commitLobby(sql, state);
  return state;
};

// Ready flip. A redundant write is an ack-only no-op — it never bumps the
// revision (a no-change broadcast would just conflict the host's edits).
export const applySetReady = (
  sql: SqlStorage,
  playerId: string,
  ready: boolean,
): LobbyState | null => {
  const lobby = readLobby(sql);
  if (lobby.ready.includes(playerId) === ready) return null;
  const state = {
    ...lobby,
    revision: lobby.revision + 1,
    ready: ready ? [...lobby.ready, playerId] : lobby.ready.filter((id) => id !== playerId),
  };
  commitLobby(sql, state);
  return state;
};

// The startGame gate — every check runs before create, first failure wins.
// Codes stay machine-readable so the client can point at the exact gate.
export const assertLobbyStartable = (
  sql: SqlStorage,
  players: readonly RoomPlayer[],
): readonly RoomPlayer[] => {
  const members = activeMembers(players);
  if (members.length < 2) {
    throw new CommandError("lobby-too-few", "at least two members are required to start");
  }
  const lobby = readLobby(sql);
  const ready = new Set(lobby.ready);
  if (members.some((m) => !ready.has(m.playerId))) {
    throw new CommandError("lobby-not-ready", "every member must be ready before start");
  }
  if (countGraphemes(lobby.scenario.trim()) === 0) {
    throw new CommandError("lobby-scenario-empty", "the scenario is empty");
  }
  const active = lobby.choices.slice(0, members.length);
  if (active.length < members.length) {
    throw new CommandError("lobby-choice-missing", "not enough choices for the members");
  }
  const seen = new Set<string>();
  for (const choice of active) {
    const key = labelKey(choice.label);
    if (key === "") {
      throw new CommandError("lobby-choice-empty", "every choice needs a label");
    }
    if (seen.has(key)) {
      throw new CommandError("lobby-choice-dup", "choice labels must be distinct");
    }
    seen.add(key);
  }
  return members;
};

// startGame commit tail — the game takes the first `count` committed
// choices; the orphan tail stays in the ledger untouched.
export const commitLobbyStart = (sql: SqlStorage, count: number): void => {
  sql.exec("UPDATE lobby SET committed_count = ? WHERE id = 1", count);
};
