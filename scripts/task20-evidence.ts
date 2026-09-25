// Task 20 evidence driver: records a real Chromium session driving the
// room presence/reconnect contract through window.__roomBridge (e2e build)
// against wrangler dev (:8787) behind the vite preview (:4173). Outputs
// into .omo/evidence/yuragoo-development/<utc>-t20/: task-20-happy.webm,
// task-20-presence.json, task-20-failure.log. Run with both dev servers
// already listening: bun scripts/task20-evidence.ts
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { JoinedAuth } from "../apps/web/src/net/room-bridge";

// window.__roomBridge is typed by the reconnect spec's global declaration
// (same tsconfig project). Evaluated code cannot see Node-side helpers —
// every callback grabs its own bridge reference.
const FAST = { initialMs: 50, maxMs: 200, seed: 3 };
const WEB = "http://127.0.0.1:4173";
const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
const OUT = join(`.omo/evidence/yuragoo-development/${stamp}-t20`);
mkdirSync(OUT, { recursive: true });

const failures: string[] = [];
const note = (line: string): void => {
  failures.push(`${new Date().toISOString()} ${line}`);
  console.log(`[failure-probe] ${line}`);
};
const firstLine = (e: unknown): string =>
  e instanceof Error ? (e.message.split("\n").at(0) ?? e.message) : String(e);

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ recordVideo: { dir: join(OUT, "video") } });
  const page = await context.newPage();
  await page.goto(WEB);
  await page.waitForFunction(() => window.__roomBridge !== undefined);

  // ---- happy path: two players, host handover, non-reclaiming return ----
  const setup = await page.evaluate(async (fast) => {
    const b = window.__roomBridge;
    if (b === undefined) throw new Error("bridge missing");
    const room = await b.createRoom("");
    const host = await b.join("", room.roomId, room.inviteSecret, "ほすと");
    const ally = await b.join("", room.roomId, room.inviteSecret, "なかま");
    const opts = (credentials: JoinedAuth) => ({
      origin: "",
      roomId: room.roomId,
      credentials,
      heartbeatMs: 250,
      backoff: fast,
    });
    await b.connectAuto("host", opts(host));
    await b.connectAuto("ally", opts(ally));
    return { roomId: room.roomId, inviteSecret: room.inviteSecret, host, ally };
  }, FAST);
  const { roomId, inviteSecret, host, ally } = setup;
  await page.waitForFunction(() => {
    const b = window.__roomBridge;
    return b?.clients.host?.snapshot != null && b?.clients.ally?.snapshot != null;
  });
  const firstHost = await page.evaluate(
    () => window.__roomBridge?.clients.host?.snapshot?.hostPlayerId,
  );
  console.log(`[happy] elected host = ${firstHost} (expect ${host.playerId})`);

  // Host drops: ally must see presenceChanged(false) then hostChanged(ally).
  await page.evaluate(() => window.__roomBridge?.close("host"));
  await page.waitForFunction(
    (allyId) =>
      (window.__roomBridge?.clients.ally?.events ?? []).some(
        (e) => e.type === "hostChanged" && e.payload.playerId === allyId,
      ),
    ally.playerId,
    { timeout: 10_000 },
  );

  // The old host returns: presence flips back, the seat stays with ally.
  await page.evaluate(
    async ({ roomId: rid, creds, fast }) => {
      const b = window.__roomBridge;
      if (b === undefined) throw new Error("bridge missing");
      await b.connectAuto("host", {
        origin: "",
        roomId: rid,
        credentials: creds,
        heartbeatMs: 250,
        backoff: fast,
      });
    },
    { roomId, creds: host, fast: FAST },
  );
  await page.waitForFunction(
    (hostId) =>
      (window.__roomBridge?.clients.ally?.events ?? []).some(
        (e) =>
          e.type === "presenceChanged" &&
          e.payload.playerId === hostId &&
          e.payload.connected === true,
      ),
    host.playerId,
    { timeout: 10_000 },
  );
  const hostAfter = await page.evaluate(
    () => window.__roomBridge?.clients.host?.snapshot?.hostPlayerId,
  );
  console.log(`[happy] host after return = ${hostAfter} (expect ${ally.playerId})`);

  // ---- presence trace artifact ----
  const trace = await page.evaluate(() => {
    const b = window.__roomBridge;
    const slim = (e: {
      serverTime: number;
      eventSeq: number;
      stateRevision: number;
      gameEpoch: number;
      type: string;
      payload: unknown;
    }) => ({
      atMs: e.serverTime,
      eventSeq: e.eventSeq,
      stateRevision: e.stateRevision,
      gameEpoch: e.gameEpoch,
      type: e.type,
      payload: e.payload,
    });
    return {
      host: b?.clients.host?.frames.map(slim),
      ally: b?.clients.ally?.frames.map(slim),
      snapshots: { host: b?.clients.host?.snapshot, ally: b?.clients.ally?.snapshot },
      reconnects: { host: b?.clients.host?.reconnects, ally: b?.clients.ally?.reconnects },
    };
  });
  writeFileSync(
    join(OUT, "task-20-presence.json"),
    JSON.stringify(
      {
        roomId,
        players: { host: host.playerId, ally: ally.playerId },
        electedHostOnJoin: firstHost,
        hostAfterOldHostReturned: hostAfter,
        stickyHostHeld: hostAfter === ally.playerId,
        ...trace,
      },
      null,
      2,
    ),
  );

  // ---- failure probes ----
  try {
    await page.evaluate(async () => window.__roomBridge?.join("", "any-room", "wrong-secret"));
    note("join/bad-invite: UNEXPECTEDLY ACCEPTED");
  } catch (e) {
    note(`join/bad-invite -> ${firstLine(e)}`);
  }
  // Empty room past grace: create, join, connect, close, wait out 1500ms.
  const expired = await page.evaluate(async (fast) => {
    const b = window.__roomBridge;
    if (b === undefined) throw new Error("bridge missing");
    const room = await b.createRoom("");
    const creds = await b.join("", room.roomId, room.inviteSecret, "まけ");
    await b.connectAuto("gone", {
      origin: "",
      roomId: room.roomId,
      credentials: creds,
      heartbeatMs: 250,
      backoff: fast,
    });
    await new Promise((r) => setTimeout(r, 300));
    b.close("gone");
    return { roomId: room.roomId, creds };
  }, FAST);
  await page.waitForTimeout(2_200); // > 1500ms empty grace
  try {
    await page.evaluate(
      async (e2) => window.__roomBridge?.rotate("", e2.roomId, e2.creds.reconnectToken),
      expired,
    );
    note("reconnect/expired-room: UNEXPECTEDLY ACCEPTED");
  } catch (e) {
    note(`reconnect/expired-room -> ${firstLine(e)}`);
  }
  try {
    await page.evaluate(
      async (e2) =>
        window.__roomBridge?.connect("late", {
          origin: "",
          roomId: e2.roomId,
          sessionToken: e2.creds.sessionToken,
        }),
      expired,
    );
    note("ticket/expired-room: UNEXPECTEDLY ACCEPTED");
  } catch (e) {
    note(`ticket/expired-room -> ${firstLine(e)}`);
  }
  // closeRoom is terminal for every client and every later join.
  await page.evaluate(() => window.__roomBridge?.send("ally", "closeRoom"));
  await page.waitForTimeout(400);
  try {
    await page.evaluate(async (r) => window.__roomBridge?.join("", r.roomId, r.invite), {
      roomId,
      invite: inviteSecret,
    });
    note("join/closed-room: UNEXPECTEDLY ACCEPTED");
  } catch (e) {
    note(`join/closed-room -> ${firstLine(e)}`);
  }
  note(
    `reconnects after roomClosed (expect 0 new): ${await page.evaluate(
      () => window.__roomBridge?.clients.ally?.reconnects,
    )}`,
  );

  writeFileSync(join(OUT, "task-20-failure.log"), `${failures.join("\n")}\n`);

  // Flush the recording and promote it to the evidence name.
  const video = page.video();
  await context.close();
  await browser.close();
  if (video !== null) copyFileSync(await video.path(), join(OUT, "task-20-happy.webm"));
  console.log(`evidence written to ${OUT}`);
};

await main();
