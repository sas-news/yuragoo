// Solo-host choice prep (Task 45): a one-member room may run the same
// one-shot generation — it produces the full seat sheet, and applying it
// appends orphan draft rows that activate as members join.
import { afterEach, expect, test } from "vitest";
import type { GenerationRequest, GenerativeProvider } from "@yuragoo/ai";
import type { ServerEnvelope } from "@yuragoo/protocol";
import { injectGenerationDeps } from "../../apps/server/src/rooms/generation-deps";
import { must } from "./room-helpers";
import { createRoom, joinRoom, latestLobby, Sock } from "./ws-helpers";

const isType = (type: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === type;
const isError = (code: string) => (e: ServerEnvelope) =>
  e.type === "error" && e.payload.code === code;

const stubProvider = (): GenerativeProvider & { calls: number } => {
  const stub: GenerativeProvider & { calls: number } = {
    calls: 0,
    async generate(req: GenerationRequest): Promise<unknown> {
      stub.calls += 1;
      return { choices: Array.from({ length: req.count }, (_, i) => `生成案${i + 1}`) };
    },
  };
  return stub;
};
afterEach(() => injectGenerationDeps({ provider: null, control: null }));

test("prep: a solo host generates the full seat sheet and applies appends", async () => {
  const stub = stubProvider();
  injectGenerationDeps({ provider: stub });
  const solo = await createRoom();
  const j = await joinRoom(solo);
  const alone = await Sock.connect(solo.roomId, j.sessionToken);
  alone.sendCmd(solo.roomId, "sc", "updateLobbyContent", {
    scenario: "夜のおやつ会議",
    expectedLobbyRevision: must(latestLobby(alone), "lobby").revision,
  });
  await alone.next(isType("lobbyChanged"));
  alone.sendCmd(solo.roomId, "s", "generateChoices", {});
  const gen = await alone.next(isType("choicesGenerated"));
  if (gen.type !== "choicesGenerated") throw new Error("bad frame");
  expect(gen.payload.labels).toHaveLength(6);
  const cur = must(latestLobby(alone), "lobby");
  expect(cur.choices).toHaveLength(1);
  alone.sendCmd(solo.roomId, "apply", "updateLobbyContent", {
    choices: gen.payload.labels.map((label, i) => ({
      choiceId: cur.choices[i]?.choiceId ?? `c${i}`,
      label,
    })),
    expectedLobbyRevision: cur.revision,
  });
  const lc = await alone.next(isType("lobbyChanged"));
  if (lc.type !== "lobbyChanged") throw new Error("bad frame");
  expect(lc.payload.choices.map((c) => c.label)).toEqual(gen.payload.labels);
  // Non-sequential / over-cap appends are refused.
  alone.sendCmd(solo.roomId, "x", "updateLobbyContent", {
    choices: [{ choiceId: "c9", label: "いんちき" }],
    expectedLobbyRevision: lc.payload.revision,
  });
  expect((await alone.next(isError("unknown-choice"))).type).toBe("error");
  alone.close();
});
