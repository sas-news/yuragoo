// Task 33 lifecycle gate (Task 32 QA tail): the kamishibai story lives
// and dies with its game. backToLobby wipes the per-game ending row so
// the next epoch never quotes a stale panel set; closeRoom deletes the
// story AND the persisted post bodies with the rest of the room; and the
// "post" generation slot is spent once per game, re-armed per epoch.
// Flow goes through real WebSocketPair clients (ws-helpers) — ending
// builds ride the same kickEnding lane the settle commit's waitUntil
// fires, joined deterministically via runInDurableObject(driveEnding).
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { GenerationRequest, GenerativeProvider } from "@yuragoo/ai";
import type { EndingStory, ServerEnvelope } from "@yuragoo/protocol";
import { injectGenerationDeps } from "../../apps/server/src/rooms/generation-deps";
import { drive, injectDeps, okUpstream, type Upstream } from "./budget-helpers";
import { assertWiped, postJson, roomStubOf } from "./room-deletion-helpers";
import { deliverAlarm, execSql, type RoomStub } from "./room-helpers";
import { armLobby, armedStart, setupRoom, Sock } from "./ws-helpers";

const isType = (t: ServerEnvelope["type"]) => (e: ServerEnvelope) => e.type === t;
const ackFor = (id: string) => (e: ServerEnvelope) =>
  e.type === "ack" && e.payload.commandId === id;

interface Gen extends GenerativeProvider {
  calls: number;
}
// Answers every allowed eventId — the parse is all-or-nothing, so the
// generated story lands whole and generated:true rides the wire.
const stubGen = (): Gen => ({
  calls: 0,
  async generate(request: GenerationRequest): Promise<unknown> {
    this.calls += 1;
    const node = request.jsonSchema as {
      properties?: { panels?: { items?: { properties?: { eventId?: { enum?: unknown } } } } };
    };
    const raw = node.properties?.panels?.items?.properties?.eventId?.enum;
    const ids = Array.isArray(raw) ? raw.filter((v): v is number => typeof v === "number") : [];
    return { title: "ものがたり", panels: ids.map((eventId) => ({ eventId, caption: "c" })) };
  },
});

let day = 0; // unique UTC day per injection — budget rows never bleed over
const genDeps = (gen: Gen): void => {
  day += 1;
  const ms = Date.parse("2026-12-01T12:00:00Z") + day * 86_400_000;
  injectGenerationDeps({ provider: gen, nowMs: () => ms, timeoutMs: 10_000 });
};
afterEach(() => injectGenerationDeps({ provider: null, control: null }));

const upstream: Upstream = { sent: 0 };
// "fetch" is the runner's upstream seam — apiKey just needs to be
// non-empty so the fail-closed gate lets the job leave.
injectDeps({ fetch: okUpstream(upstream), apiKey: "story-test" });

const endingRow = async (stub: RoomStub): Promise<EndingStory | null> => {
  const row = (await execSql(stub, "SELECT panel FROM ending WHERE id = 1"))[0];
  return typeof row?.panel === "string" ? (JSON.parse(row.panel) as EndingStory) : null;
};

const driveEnding = (stub: RoomStub): Promise<void> =>
  runInDurableObject(stub, (i) => i.driveEnding());

const until = async (fn: () => Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("probe timed out");
    await new Promise((r) => setTimeout(r, 60));
  }
};

// Post one text per socket (LIVE: no turns), land the evaluations, then
// hostDecision -> requestDecision -> the settle alarm -> finished.
const playLive = async (
  roomId: string,
  stub: RoomStub,
  socks: readonly Sock[],
  texts: readonly string[],
  tag: string,
): Promise<void> => {
  for (const [i, t] of texts.entries()) {
    const s = socks[i % socks.length];
    if (s === undefined) throw new Error("playLive needs socks");
    s.sendCmd(roomId, `${tag}-p${i}`, "submitText", { text: t });
    await s.next(ackFor(`${tag}-p${i}`));
  }
  await drive(stub); // real eval path: decisionUpdated rows feed the story
  const host = socks[0] as Sock;
  host.sendCmd(roomId, `${tag}-end`, "requestDecision", {});
  await host.next(ackFor(`${tag}-end`));
  await until(async () => {
    await deliverAlarm(stub);
    const row = await execSql(stub, "SELECT phase FROM room_meta WHERE id = 1");
    return row[0]?.phase === "finished";
  });
  await driveEnding(stub); // join (or run) the ending lane the settle kicked
};

const LIVE = { mode: "live", seed: 7, liveSeconds: 120, settleSeconds: 2, hostDecision: true };

test("backToLobby wipes the story; the next epoch rebuilds its own", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = joins;
  if (!h || !a) throw new Error("joins missing");
  const sh = await Sock.connect(room.roomId, h.sessionToken);
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const stub = roomStubOf(room.roomId);
  const gen = stubGen();
  genDeps(gen);
  await armedStart(room, [sh, sa], "go", LIVE);
  await sh.next(ackFor("go"));
  await playLive(
    room.roomId,
    stub,
    [sh, sa],
    ["よるのおやつをもぐもぐ", "いっしょにわらった"],
    "g1",
  );
  const first = await endingRow(stub);
  expect(first?.gameEpoch).toBe(1);
  expect(gen.calls).toBe(1); // the "post" slot fired once
  expect(await stub.tryGenerationSlot("post")).toBe(false);
  expect(JSON.stringify(first?.panels ?? [])).toContain("よるのおやつをもぐもぐ");
  // backToLobby is a member command, not a game action — it rides the
  // socket like the UI does. The ack means the reopen commit landed.
  sa.sendCmd(room.roomId, "back-1", "backToLobby", {});
  await sa.next(ackFor("back-1"));
  await sh.next(isType("lobbyReopened"));
  expect(await endingRow(stub)).toBeNull(); // the per-game story died
  // Re-arm + start on the same stub: epoch 2 gets its own ending row and
  // its own "post" slot — the generation call count climbs again.
  await armLobby(room, [sh, sa], undefined, "re");
  sh.sendCmd(room.roomId, "go-2", "startGame", {});
  await sh.next(ackFor("go-2"));
  await playLive(room.roomId, stub, [sh, sa], ["あさのひかりのなかで"], "g2");
  const second = await endingRow(stub);
  // The epoch counter lives in room_meta (wiped by the reopen), so the
  // new game may reuse epoch 1 — freshness is proven by content: this
  // story quotes tonight's post and never the old game's text.
  const body = JSON.stringify(second?.panels ?? []);
  expect(second).not.toBeNull();
  expect(body).toContain("あさのひかりのなかで");
  expect(body).not.toContain("よるのおやつをもぐもぐ");
  expect(gen.calls).toBe(2); // the "post" slot re-arms per game
  for (const s of [sh, sa]) s.close();
});

test("closeRoom deletes the story and the persisted post bodies", async () => {
  const { room, joins } = await setupRoom(2);
  const [h, a] = joins;
  if (!h || !a) throw new Error("joins missing");
  const sh = await Sock.connect(room.roomId, h.sessionToken);
  const sa = await Sock.connect(room.roomId, a.sessionToken);
  const stub = roomStubOf(room.roomId);
  genDeps(stubGen());
  await armedStart(room, [sh, sa], "go-c", LIVE);
  await sh.next(ackFor("go-c"));
  await playLive(room.roomId, stub, [sh, sa], ["ふかいうみのそこで"], "gc");
  expect(await endingRow(stub)).not.toBeNull();
  // Post bodies live only in room_meta's snapshot — prove it held text
  // before the close so the wipe assert means content died, not nothing.
  const meta = await execSql(stub, "SELECT snapshot FROM room_meta WHERE id = 1");
  expect(JSON.stringify(meta[0] ?? {})).toContain("ふかいうみのそこで");
  sh.sendCmd(room.roomId, "close-1", "closeRoom");
  await sh.next(ackFor("close-1"));
  await sa.next(isType("roomClosed"));
  for (const s of [sh, sa]) {
    const info = await s.waitClose();
    expect(info.code).toBe(1000);
  }
  await assertWiped(stub); // every data table incl. ending + room_meta
  const res = await postJson(`/api/rooms/${room.roomId}/join`, {
    inviteSecret: room.inviteSecret,
  });
  expect(res.status).toBe(410); // post-close content is unreachable
});
