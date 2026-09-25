// Quick probe: fold the exact live event sequence through room-view and
// see what latestRoomDist/roomSamples produce.
import { LOBBY_SETTINGS_DEFAULT } from "@yuragoo/protocol";
import { latestRoomDist, roomSamples } from "../apps/web/src/lobby/room-arena";
import { applyEvent, initialView } from "../apps/web/src/lobby/room-view";

const env = (type: string, payload: unknown, seq: number) =>
  ({
    protocolVersion: 1,
    eventSeq: seq,
    stateRevision: seq,
    gameId: "r",
    gameEpoch: 1,
    serverTime: Date.now(),
    type,
    payload,
  }) as never;

let v = initialView();
v = applyEvent(
  v,
  env(
    "lobbyChanged",
    {
      revision: 5,
      scenario: "浜辺で貝殻を見つけた。どうする？",
      choices: [
        { choiceId: "c0", label: "拾う" },
        { choiceId: "c1", label: "眺める" },
      ],
      ready: [],
      committedCount: 2,
      generationSpent: false,
      settings: LOBBY_SETTINGS_DEFAULT,
    },
    1,
  ),
);
v = applyEvent(
  v,
  env(
    "phaseChanged",
    {
      phase: "playing",
      event: {
        type: "started",
        roster: [
          { id: "A", slot: 0 },
          { id: "B", slot: 1 },
        ],
      },
    },
    2,
  ),
);
v = applyEvent(
  v,
  env("phaseChanged", { phase: "playing", event: { type: "turn", round: 0, playerId: "B" } }, 3),
);
v = applyEvent(
  v,
  env(
    "inputAccepted",
    {
      phase: "playing",
      event: { type: "posted", postId: "p1", playerId: "B" },
      post: { postId: "p1", playerId: "B", seq: 1, text: "拾って匂いをかぐ", status: "pending" },
    },
    4,
  ),
);
v = applyEvent(
  v,
  env("phaseChanged", { phase: "playing", event: { type: "turn", round: 0, playerId: "A" } }, 5),
);
v = applyEvent(
  v,
  env(
    "decisionUpdated",
    {
      postId: "p1",
      revision: 1,
      distribution: [
        { choiceId: "c0", probability: 0.85 },
        { choiceId: "c1", probability: 0.15 },
      ],
    },
    6,
  ),
);

console.log("posts:", JSON.stringify(v.posts));
console.log("dists keys:", [...v.dists.keys()]);
const dist = latestRoomDist(v);
console.log("latestRoomDist:", JSON.stringify(dist));
console.log("samples:", JSON.stringify(roomSamples(dist, v)));
