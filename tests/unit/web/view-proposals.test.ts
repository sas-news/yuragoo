// Task 44: the scenario-generation fold — the proposal rides its own
// slot, a scoped failure only burns the matching flag, and an absent
// scope stays the legacy choices interpretation.
import { describe, expect, test } from "bun:test";
import { LOBBY_SETTINGS_DEFAULT, type LobbyState, type ServerEnvelope } from "@yuragoo/protocol";
import { applyEvent, initialView } from "../../../apps/web/src/lobby/room-view";

const lobby = (over: Partial<LobbyState> = {}): LobbyState => ({
  revision: 1,
  scenario: "",
  choices: [],
  ready: [],
  committedCount: 0,
  generationSpent: false,
  scenarioSpent: false,
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

describe("scenario generation fold (Task 44)", () => {
  test("scenarioGenerated lands a proposal and burns only its own slot", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env("scenarioGenerated", { lobbyRevision: 4, scenario: "夜のピクニック" }, 1),
    );
    expect(v.scenarioProposal).toEqual({ lobbyRevision: 4, scenario: "夜のピクニック" });
    expect(v.lobby.scenarioSpent).toBe(true);
    expect(v.lobby.generationSpent).toBe(false); // the choices slot is untouched
    expect(v.choiceProposal).toBeNull();
    expect(v.generationError).toBeNull();
  });

  test("a scoped failure burns only the scenario slot; unscoped stays choices", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env(
        "generationFailed",
        { code: "generation-timeout", message: "x", slotSpent: true, scope: "scenario" },
        1,
      ),
    );
    expect(v.lobby.scenarioSpent).toBe(true);
    expect(v.lobby.generationSpent).toBe(false);
    expect(v.scenarioProposal).toBeNull();
    // Pre-Task-44 failures carried no scope — they must keep burning the
    // choices slot they were always about.
    v = applyEvent(
      v,
      env("generationFailed", { code: "generation-invalid", message: "y", slotSpent: true }, 2),
    );
    expect(v.lobby.generationSpent).toBe(true);
    expect(v.generationError?.code).toBe("generation-invalid");
  });

  test("the two proposals are independent; a heal clears neither flag", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env("choicesGenerated", { lobbyRevision: 1, memberCount: 2, labels: ["a", "b"] }, 1),
    );
    v = applyEvent(v, env("scenarioGenerated", { lobbyRevision: 1, scenario: "月の砂漠" }, 2));
    expect(v.choiceProposal?.labels).toEqual(["a", "b"]);
    expect(v.scenarioProposal?.scenario).toBe("月の砂漠");
    expect(v.lobby.generationSpent).toBe(true);
    expect(v.lobby.scenarioSpent).toBe(true);
    // A fresh lobbyChanged (say a roster move) leaves both flags alone —
    // the server view is authoritative for them.
    v = applyEvent(
      v,
      env("lobbyChanged", lobby({ revision: 2, generationSpent: true, scenarioSpent: true }), 3),
    );
    expect(v.lobby.generationSpent).toBe(true);
    expect(v.lobby.scenarioSpent).toBe(true);
  });
});
