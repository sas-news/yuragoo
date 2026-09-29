// Task 29: the room view's event fold — lobbyChanged updates state but
// never enters the feed, lobbyReopened collapses the game back to a clean
// lobby, and member names fall back to stable seat labels (never raw ids).
import { describe, expect, test } from "bun:test";
import {
  type ChoiceId,
  LOBBY_SETTINGS_DEFAULT,
  type LobbyState,
  type RoomPlayerView,
  type ServerEnvelope,
} from "@yuragoo/protocol";
import { applyEvent, applySnapshot, initialView } from "../../../apps/web/src/lobby/room-view";
import { latestVerdictPostId, moodOf } from "../../../apps/web/src/lobby/view-decisions";
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

describe("decision verdict fold — mood belongs to its post (Task 43)", () => {
  const dist = [
    { choiceId: "c0" as ChoiceId, probability: 0.7 },
    { choiceId: "c1" as ChoiceId, probability: 0.3 },
  ];
  const post = (id: string, seq: number) => ({
    postId: id,
    playerId: "a",
    text: "すすむ",
    postedAtMs: 0,
    seq,
    status: "pending" as const,
  });
  const accepted = (id: string, seq: number): ServerEnvelope =>
    env(
      "inputAccepted",
      {
        event: { type: "posted", postId: id, playerId: "a" },
        phase: "playing",
        post: post(id, seq),
      },
      seq,
    );

  test("decisionUpdated lands dist and mood on the same postId", () => {
    let v = initialView();
    v = applyEvent(v, accepted("p1", 1));
    v = applyEvent(
      v,
      env("decisionUpdated", { postId: "p1", distribution: dist, mood: "engaged" }, 2),
    );
    expect(v.dists.get("p1")).toEqual(dist);
    expect(v.moods.get("p1")).toBe("engaged");
    expect(v.posts[0]?.status).toBe("evaluated");
    // A mood-less verdict still lands its dist — that post's face just
    // falls back to the shape heuristic; the mood map itself is untouched.
    v = applyEvent(v, accepted("p2", 3));
    v = applyEvent(v, env("decisionUpdated", { postId: "p2", distribution: dist }, 4));
    expect(v.dists.get("p2")).toEqual(dist);
    expect(v.moods.has("p2")).toBe(false);
  });

  test("the mood lookup pairs with the post driving the pull", () => {
    // latestVerdictPostId walks to the newest evaluated post that landed a
    // dist; moodOf reads THAT post's mood — a newer pull can never wear an
    // older verdict's face.
    const posts = [
      { ...post("p1", 1), status: "evaluated" as const },
      { ...post("p2", 2), status: "evaluated" as const },
    ];
    const dists = new Map([
      ["p1", dist],
      ["p2", dist],
    ]);
    const moods = new Map([["p1", "bored" as const]]);
    const id = latestVerdictPostId(posts, dists);
    expect(id).toBe("p2");
    expect(moodOf(moods, id)).toBeNull(); // p2 carried no mood — fallback
    expect(moodOf(moods, "p1")).toBe("bored");
  });

  test("a new epoch clears moods with the pull memory; snapshots heal them", () => {
    let v = initialView();
    v = applyEvent(v, accepted("p1", 1));
    v = applyEvent(
      v,
      env("decisionUpdated", { postId: "p1", distribution: dist, mood: "adhering" }, 2),
    );
    v = applyEvent(
      v,
      env(
        "phaseChanged",
        { event: { type: "started", roster: [{ id: "a", slot: 0 }] }, phase: "playing" },
        3,
      ),
    );
    expect(v.moods.size).toBe(0);
    expect(v.dists.size).toBe(0);
    // A reconnect heals moods straight from the snapshot's parallel map.
    const healed = applySnapshot(initialView(), {
      state: null,
      phase: "lobby",
      inputSeq: 0,
      players: [],
      hostPlayerId: null,
      lobby: lobby(),
      moods: { p9: "bored" },
    });
    expect(healed.moods.get("p9")).toBe("bored");
  });
});
