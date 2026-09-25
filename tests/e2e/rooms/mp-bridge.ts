// Task 23 e2e bridge conveniences: page-side actions all go through
// window.__roomBridge; waits are event-driven probes on the live view.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JoinedAuth, RoomBridge } from "../../../apps/web/src/net/room-bridge";

declare global {
  interface Window {
    __roomBridge?: RoomBridge;
  }
}

export const gotoBridge = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.waitForFunction(() => window.__roomBridge !== undefined);
};

export interface Seat {
  readonly page: Page;
  readonly id: string;
  playerId: string;
}

// One real browser context per seat — an independent client (own socket,
// own credentials, own session storage) like a separate browser.
export const openPages = async (
  browser: Browser,
  count: number,
  contexts: BrowserContext[],
  videoDir?: string,
): Promise<Page[]> => {
  const pages: Page[] = [];
  for (let i = 0; i < count; i += 1) {
    const ctx = await browser.newContext(
      i === 0 && videoDir !== undefined
        ? { recordVideo: { dir: videoDir, size: { width: 640, height: 480 } } }
        : {},
    );
    contexts.push(ctx);
    const page = await ctx.newPage();
    await gotoBridge(page);
    pages.push(page);
  }
  return pages;
};

const joinAndConnect = (
  page: Page,
  args: { id: string; roomId: string; inviteSecret: string; name: string; origin: string },
): Promise<JoinedAuth> =>
  page.evaluate(async ({ id, roomId, inviteSecret, name, origin }) => {
    const bridge = window.__roomBridge;
    if (bridge === undefined) throw new Error("room bridge missing");
    const auth = await bridge.join(origin, roomId, inviteSecret, name);
    await bridge.connectAuto(id, {
      origin,
      roomId,
      credentials: auth,
      heartbeatMs: 250,
      backoff: { initialMs: 60, maxMs: 250, seed: id.length * 31 + id.charCodeAt(0) },
    });
    return auth;
  }, args);

// Create the room on pages[0], then join + connect every page in order
// (joinOrder == seat order, so seat[0] is the elected host).
export const openRoom = async (
  pages: readonly Page[],
  origin = "",
): Promise<{ roomId: string; seats: Seat[] }> => {
  const first = pages[0];
  if (first === undefined) throw new Error("openRoom needs at least one page");
  const created = await first.evaluate((o) => {
    const bridge = window.__roomBridge;
    if (bridge === undefined) throw new Error("room bridge missing");
    return bridge.createRoom(o);
  }, origin);
  const seats: Seat[] = [];
  for (const [i, page] of pages.entries()) {
    const id = `c${i}`;
    const auth = await joinAndConnect(page, {
      id,
      roomId: created.roomId,
      inviteSecret: created.inviteSecret,
      name: `プレイヤー${i + 1}`,
      origin,
    });
    seats.push({ page, id, playerId: auth.playerId });
  }
  return { roomId: created.roomId, seats };
};

export const send = (seat: Seat, type: string, payload?: unknown): Promise<unknown> =>
  seat.page.evaluate(
    ({ id, t, p }) => window.__roomBridge?.send(id, t, p) ?? Promise.reject(new Error("no bridge")),
    { id: seat.id, t: type, p: payload },
  );

export const closeClient = (seat: Seat): Promise<void> =>
  seat.page.evaluate((id) => {
    window.__roomBridge?.close(id);
  }, seat.id);

export type Probe =
  | { kind: "event"; type: string; eventType?: string; playerId?: string; minCount?: number }
  | { kind: "frames"; type: string; minCount: number }
  | { kind: "phaseEventAfter"; seq: number }
  | { kind: "reconnects"; min: number }
  | { kind: "closed" };

export const waitFor = async (seat: Seat, p: Probe, timeout = 20_000): Promise<void> => {
  await seat.page.waitForFunction(
    ({ id, probe }) => {
      const v = window.__roomBridge?.clients[id];
      if (v === undefined) return false;
      if (probe.kind === "closed") return v.closed !== null;
      if (probe.kind === "reconnects") return v.reconnects >= probe.min;
      if (probe.kind === "frames")
        return v.frames.filter((f) => f.type === probe.type).length >= probe.minCount;
      if (probe.kind === "phaseEventAfter")
        return v.events.some((e) => e.type === "phaseChanged" && e.eventSeq > probe.seq);
      const count = v.events.filter((e) => {
        if (e.type !== probe.type) return false;
        const pl = e.payload as {
          playerId?: string;
          event?: { type?: string; playerId?: string };
        };
        if (probe.eventType !== undefined && pl.event?.type !== probe.eventType) return false;
        if (probe.playerId !== undefined) {
          const pid = pl.playerId ?? pl.event?.playerId;
          if (pid !== probe.playerId) return false;
        }
        return true;
      }).length;
      return count >= (probe.minCount ?? 1);
    },
    { id: seat.id, probe: p },
    { timeout },
  );
};

export const lastPhaseEvent = (
  seat: Seat,
): Promise<{ type: string; playerId: string; seq: number } | null> =>
  seat.page.evaluate((id) => {
    const v = window.__roomBridge?.clients[id];
    if (v === undefined) return null;
    for (let i = v.events.length - 1; i >= 0; i -= 1) {
      const e = v.events[i];
      if (e === undefined || e.type !== "phaseChanged") continue;
      const ev = (e.payload as { event?: { type?: string; playerId?: string } }).event;
      if (ev === undefined) continue;
      if (ev.type === "turn") return { type: "turn", playerId: ev.playerId ?? "", seq: e.eventSeq };
      if (ev.type === "complete" || ev.type === "finished") {
        return { type: ev.type, playerId: "", seq: e.eventSeq };
      }
    }
    return null;
  }, seat.id);

export const lastSeq = (seat: Seat): Promise<number | null> =>
  seat.page.evaluate((id) => {
    const v = window.__roomBridge?.clients[id];
    return v?.conn?.current?.lastEventSeq ?? null;
  }, seat.id);

// What the spec proves identical across every context: the finished
// frame's outcome + persisted seq/revision/epoch, the post-start ordered
// stream digest and the client's sync head. The raw ordered stream is
// returned; mp-assert derives the post-start digest (pre-start presence
// differs per seat by join order — that is by design, not divergence).
export const collectProof = (seat: Seat) =>
  seat.page.evaluate((id) => {
    const v = window.__roomBridge?.clients[id];
    if (v === undefined) return null;
    const finished = v.events.find(
      (e) =>
        e.type === "phaseChanged" &&
        (e.payload as { event?: { type?: string } }).event?.type === "finished",
    );
    return {
      playerId: v.conn?.credentials.playerId ?? null,
      phase: v.snapshot?.phase ?? null,
      finished:
        finished === undefined ? null : ((finished.payload as { event?: unknown }).event ?? null),
      finishedFrame:
        finished === undefined
          ? null
          : {
              eventSeq: finished.eventSeq,
              stateRevision: finished.stateRevision,
              gameEpoch: finished.gameEpoch,
            },
      lastEventSeq: v.conn?.current?.lastEventSeq ?? null,
      snapshotPosts: v.snapshot?.state?.posts.length ?? -1,
      stream: v.events.map((e) => `${e.eventSeq}:${e.type}`),
      reconnects: v.reconnects,
    };
  }, seat.id);

// One-shot dropper: swallow the next `count` ordered frames before the
// sync machine sees them, forcing the real gap -> syncRequest -> snapshot path.
export const swallowFrames = (seat: Seat, count: number): Promise<void> =>
  seat.page.evaluate(
    ({ id, count }) => {
      const client = window.__roomBridge?.clients[id]?.conn?.current;
      if (client === null || client === undefined) throw new Error("no live client");
      const target = client as unknown as { onMessage(raw: string): void };
      const orig = target.onMessage.bind(client);
      let left = count;
      target.onMessage = (raw: string) => {
        const ordered =
          raw.includes('"type":"inputAccepted"') ||
          raw.includes('"type":"phaseChanged"') ||
          raw.includes('"type":"decisionUpdated"');
        if (left > 0 && ordered) {
          left -= 1;
          return;
        }
        orig(raw);
      };
    },
    { id: seat.id, count },
  );

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
export const EVIDENCE_DIR = join(
  process.cwd(),
  ".omo/evidence/yuragoo-development",
  `${stamp}-t23`,
);

export const writeEvidence = (name: string, data: unknown): void => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, name),
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
  );
};
