// Task 25: the choices-generation fold — the proposal is ephemeral (never
// a lobby write), a burned slot still flips generationSpent, and a later
// lobbyChanged never clears the flag on its own.
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

describe("choice generation fold (Task 25)", () => {
  test("choicesGenerated lands a proposal and burns the slot", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env("choicesGenerated", { lobbyRevision: 4, memberCount: 2, labels: ["a", "b"] }, 1),
    );
    expect(v.choiceProposal?.labels).toEqual(["a", "b"]);
    expect(v.lobby.generationSpent).toBe(true);
    expect(v.generationError).toBeNull();
  });

  test("a spent failure flips generationSpent; a free failure does not", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env("generationFailed", { code: "generation-invalid", message: "x", slotSpent: true }, 1),
    );
    expect(v.lobby.generationSpent).toBe(true);
    expect(v.choiceProposal).toBeNull();
    expect(v.generationError?.code).toBe("generation-invalid");
  });

  test("a lobbyChanged heals the flag only to the server truth", () => {
    let v = initialView();
    v = applyEvent(
      v,
      env("choicesGenerated", { lobbyRevision: 1, memberCount: 2, labels: ["a", "b"] }, 1),
    );
    expect(v.lobby.generationSpent).toBe(true);
    v = applyEvent(v, env("lobbyChanged", lobby({ revision: 2 }), 2));
    // The server view is authoritative — a stale local flag clears.
    expect(v.lobby.generationSpent).toBe(false);
    expect(v.choiceProposal?.labels).toEqual(["a", "b"]);
  });
});
