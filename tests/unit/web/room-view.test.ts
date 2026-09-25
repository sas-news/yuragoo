// Task 29: the room view's event fold — lobbyChanged updates state but
// never enters the feed, lobbyReopened collapses the game back to a clean
// lobby, and member names fall back to stable seat labels (never raw ids).
import { describe, expect, test } from "bun:test";
import {
  LOBBY_SETTINGS_DEFAULT,
  type LobbyState,
  type RoomPlayerView,
  type ServerEnvelope,
} from "@yuragoo/protocol";
import { applyEvent, initialView } from "../../../apps/web/src/lobby/room-view";
import { memberName } from "../../../apps/web/src/lobby/view-members";

const lobby = (over: Partial<LobbyState> = {}): LobbyState => ({
  revision: 1,
  scenario: "",
  choices: [],
  ready: [],
  committedCount: 0,
  generationSpent: false,
  settings: LOBBY_SETTINGS_DEFAULT,
  ...over,
});

const env = (type: ServerEnvelope["type"], payload: unknown, seq: number): ServerEnvelope =>
  ({
    protocolVersion: 1,
    eventSeq: seq,
    stateRevision: seq,
    gameId: "room-1",
    gameEpoch: 1,
    serverTime: Date.now(),
    type,
    payload,
  }) as ServerEnvelope;

const player = (id: string, joinOrder: number, name: string | null): RoomPlayerView => ({
  playerId: id,
  joinOrder,
  displayName: name,
  lobbyWaiting: false,
  connected: true,
});

describe("room view event fold", () => {
  test("lobbyChanged updates the lobby but never touches the feed", () => {
    let v = initialView();
    v = applyEvent(v, env("lobbyChanged", lobby({ revision: 3, scenario: "夜食" }), 1));
    expect(v.lobby.scenario).toBe("夜食");
    expect(v.lobby.revision).toBe(3);
    expect(v.feed).toHaveLength(0); // a line per keystroke would flood it
    v = applyEvent(v, env("hostChanged", { playerId: "p1" }, 2));
    expect(v.feed).toHaveLength(1);
    v = applyEvent(v, env("lobbyChanged", lobby({ revision: 4 }), 3));
    expect(v.feed).toHaveLength(1); // still no feed line
  });

  test("lobbyReopened folds the finished game back to a clean lobby", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env(
        "phaseChanged",
        {
          event: {
            type: "started",
            roster: [
              { id: "p1", slot: 0 },
              { id: "p2", slot: 1 },
            ],
          },
          phase: "playing",
        },
        1,
      ),
    );
    v = applyEvent(
      v,
      env(
        "phaseChanged",
        { event: { type: "turn", round: 0, playerId: "p1" }, phase: "playing" },
        2,
      ),
    );
    v = applyEvent(
      v,
      env(
        "phaseChanged",
        { event: { type: "finished", outcome: { kind: "noContest" } }, phase: "finished" },
        3,
      ),
    );
    expect(v.phase).toBe("finished");
    v = applyEvent(
      v,
      env(
        "lobbyReopened",
        lobby({ revision: 9, scenario: "夜食", choices: [{ choiceId: "c0", label: "a" }] }),
        4,
      ),
    );
    expect(v.phase).toBe("lobby");
    expect(v.state).toBeNull();
    expect(v.turn).toBeNull();
    expect(v.posts).toEqual([]);
    expect(v.dists.size).toBe(0);
    expect(v.deadlineAtMs).toBeNull();
    expect(v.lobby.revision).toBe(9);
    expect(v.lobby.choices).toHaveLength(1);
    // The reopen line itself DOES land on the feed (meaningful, not spam).
    expect(v.feed.at(-1)?.type).toBe("lobbyReopened");
  });

  test("memberJoined upserts by joinOrder; hostChanged moves the pointer", () => {
    let v = initialView();
    v = applyEvent(v, env("memberJoined", player("b", 1, "れん"), 1));
    v = applyEvent(v, env("memberJoined", player("a", 0, null), 2));
    expect(v.players.map((p) => p.playerId)).toEqual(["a", "b"]);
    v = applyEvent(v, env("hostChanged", { playerId: "b" }, 3));
    expect(v.hostPlayerId).toBe("b");
    v = applyEvent(v, env("memberLeft", { playerId: "a" }, 4));
    expect(v.players.map((p) => p.playerId)).toEqual(["b"]);
  });

  test("memberName never renders a raw id: stable seat labels everywhere", () => {
    const players = [player("a", 0, null), player("b", 1, "  "), player("c", 2, "れん")];
    expect(memberName(players, "a")).toBe("プレイヤー1");
    expect(memberName(players, "b")).toBe("プレイヤー2"); // blank name -> fallback
    expect(memberName(players, "c")).toBe("れん");
    expect(memberName(players, "departed")).toBe("メンバー"); // left the room
  });
});
