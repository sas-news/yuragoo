// buildLocalSettings (Task 15 URL knobs + Task 26 switches): the generous
// local turn slot stays, ?turn/?dwell overrides land, and devMode keeps the
// free-range values valid while BOTH early-end switches stay explicitly on
// so local early-end behaviour is unchanged by the new server defaults.
import { describe, expect, test } from "bun:test";
import { reduce } from "@yuragoo/game-core";
import { buildLocalSettings, parseLocalParams } from "../../../apps/web/src/local/session";

describe("buildLocalSettings", () => {
  test("defaults turnSeconds to the generous local slot, honors overrides", () => {
    const setup = { players: 4, mode: "turn" as const, seed: 7 };
    const base = parseLocalParams("");
    expect(buildLocalSettings(setup, base).turnSeconds).toBe(300);
    const tuned = parseLocalParams("turn=20&dwell=8");
    expect(buildLocalSettings(setup, tuned)).toMatchObject({
      turnSeconds: 20,
      adhesionSeconds: 8,
      rosterSize: 4,
    });
  });

  test("Task 26: local play keeps both early-end switches on via devMode", () => {
    const setup = { players: 4, mode: "turn" as const, seed: 7 };
    const built = buildLocalSettings(setup, parseLocalParams(""));
    // devMode keeps the free-range knobs (turnSeconds 300) valid; both
    // optional switches stay on so the local early-end paths are unchanged.
    expect(built).toMatchObject({
      devMode: true,
      earlyDecision: true,
      hostDecision: true,
    });
    const state = reduce(null, {
      type: "create",
      settings: built,
      playerIds: ["a", "b", "c", "d"],
      nowMs: 0,
    }).state;
    expect(state.settings.turnSeconds).toBe(300);
    expect(state.settings.earlyDecision).toBe(true);
    expect(state.settings.hostDecision).toBe(true);
  });
});
