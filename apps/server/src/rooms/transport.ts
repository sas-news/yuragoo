// DO-side WebSocket plumbing (Task 19) + presence delegation (Task 20):
// hibernation handlers, frame guards, envelope parsing, delivery, broadcast.
// Upgrade admission lives in ./admit; room effects go through commands.ts
// and presence.ts — this module moves bytes and enforces transport rules
// (oversized -> 1009; malformed/stale -> error frame; rate bounds), the
// expired guard, and a lazy lease sweep on every entrypoint.
import { GameRuleError } from "@yuragoo/game-core";
import { clientEnvelopeSchema, type ClientEnvelope, protocolVersion } from "@yuragoo/protocol";
import { RoomError } from "./api";
import type { RoomPlayer } from "./auth-storage";
import { type CommandHost, type CommandOutcome, runClientCommand } from "./commands";
import { commitPresence, disconnect, sweepExpiredLeases } from "./presence";
import {
  attachmentOf,
  broadcastEnvelope,
  CommandError,
  frame,
  sendTo,
  type SocketAttachment,
} from "./wire";

// Socket helpers moved to wire.ts in Task 20; re-export for importers.
export { attachmentOf, broadcastEnvelope, sendTo } from "./wire";
export type { SocketAttachment } from "./wire";

export const MAX_FRAME_BYTES = 16 * 1024;
// Rate bound: 64 commands per socket per sliding 10s window (see contract).
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX_COMMANDS = 64;

const encoder = new TextEncoder();

// The GameRoom surface transport needs, on top of the command host.
export interface SocketHost extends CommandHost {
  storage(): DurableObjectStorage;
  isClosed(): boolean;
  assertLive(): void; // closed + empty-grace-expired guard for every read/join/command path
  acceptSocket(ws: WebSocket, attachment: SocketAttachment): void;
  sockets(): readonly WebSocket[];
  listPlayers(): readonly RoomPlayer[];
  retireRoom(): Promise<void>;
  waitUntil(p: Promise<void>): void;
  leaseMs(): number;
  emptyGraceMs(): number;
  purgeDelayMs(): number; // expiry->purge hysteresis (Task 21)
  driveOutbox(): Promise<void>;
  retryWipe(): Promise<void>;
  // Task 22/32 drives — never block the handler on them.
  driveDecisionJobs(): Promise<void>;
  driveEnding(): Promise<void>;
}

const sendError = (
  host: SocketHost,
  ws: WebSocket,
  code: string,
  message: string,
  commandId?: string,
): void => {
  const revision = host.booksView()?.meta.stateRevision ?? 0;
  sendTo(
    ws,
    frame(host, revision, revision, "error", {
      code,
      message,
      ...(commandId === undefined ? {} : { commandId }),
    }),
  );
};

// Per-socket rate window (in-memory; a hibernated socket resets — bursts are live-connection concerns).

const windows = new Map<WebSocket, number[]>();

const rateAllow = (ws: WebSocket): boolean => {
  const now = Date.now();
  const log = (windows.get(ws) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (log.length >= RATE_MAX_COMMANDS) {
    windows.set(ws, log);
    return false;
  }
  log.push(now);
  windows.set(ws, log);
  return true;
};

// Hibernation handlers.

const codeOf = (error: unknown): string => {
  if (error instanceof CommandError || error instanceof RoomError) return error.code;
  if (error instanceof GameRuleError) return error.reason;
  return "internal";
};

const deliver = (host: SocketHost, ws: WebSocket, outcome: CommandOutcome): void => {
  if (outcome.ack !== null) sendTo(ws, outcome.ack);
  for (const event of outcome.events) broadcastEnvelope(host, event);
  if (outcome.reply !== null) sendTo(ws, outcome.reply);
};

export const handleMessage = async (
  host: SocketHost,
  ws: WebSocket,
  message: string | ArrayBuffer,
): Promise<void> => {
  const attachment = attachmentOf(ws);
  if (attachment === null) {
    sendError(host, ws, "unauthorized", "socket has no room attachment");
    ws.close(1008, "unauthorized");
    return;
  }
  // Every command entrypoint enforces the empty-grace expiry first, then
  // lazily sweeps lapsed leases — the alarm does the same on a timer, but
  // a late alarm must never let a dead room or a stale presence through.
  try {
    host.assertLive();
  } catch (error) {
    sendError(host, ws, codeOf(error), error instanceof Error ? error.message : "room is gone");
    return;
  }
  const swept = commitPresence(host, (h) => sweepExpiredLeases(h, Date.now()));
  if (swept.expiredIds.includes(attachment.playerId)) return; // our own lease lapsed
  const bytes = typeof message === "string" ? encoder.encode(message).length : message.byteLength;
  if (bytes > MAX_FRAME_BYTES) {
    sendError(host, ws, "frame-too-large", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
    ws.close(1009, "frame-too-large");
    return;
  }
  if (typeof message !== "string") {
    sendError(host, ws, "expected-text-frame", "command frames must be JSON text");
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    sendError(host, ws, "malformed-json", "frame is not valid JSON");
    return;
  }
  const parsed = clientEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    // A schema-invalid frame can still carry a usable commandId — echo it so
    // the sender's pending ack rejects with this code instead of timing out.
    const cid = (raw as { commandId?: unknown } | null)?.commandId;
    sendError(
      host,
      ws,
      "invalid-envelope",
      "frame does not match the client envelope schema",
      typeof cid === "string" ? cid : undefined,
    );
    return;
  }
  const env: ClientEnvelope = parsed.data;
  if (env.protocolVersion !== protocolVersion) {
    sendError(
      host,
      ws,
      "unsupported-protocol",
      `protocolVersion ${env.protocolVersion} is not supported`,
      env.commandId,
    );
    return;
  }
  if (env.gameId !== host.roomId) {
    sendError(host, ws, "wrong-room", "envelope gameId does not match this room", env.commandId);
    return;
  }
  if (env.type !== "syncRequest" && env.expectedGameEpoch !== host.roomEpoch()) {
    sendError(
      host,
      ws,
      "stale-epoch",
      "expectedGameEpoch is behind; send syncRequest",
      env.commandId,
    );
    return;
  }
  // Only well-formed commands consume rate budget; garbage frames are
  // rejected above for free.
  if (!rateAllow(ws)) {
    sendError(
      host,
      ws,
      "rate-limited",
      `over ${RATE_MAX_COMMANDS} commands per ${RATE_WINDOW_MS}ms`,
    );
    return;
  }
  try {
    const outcome = runClientCommand(host, attachment.playerId, env);
    deliver(host, ws, outcome);
    // Task 24 `leave`: the departed member's sockets close only after
    // their ack + the broadcast frames have been written to the wire.
    if (outcome.dropPlayerIds.length > 0) {
      const drop = new Set(outcome.dropPlayerIds);
      for (const socket of host.sockets()) {
        const att = attachmentOf(socket);
        if (att !== null && drop.has(att.playerId)) {
          try {
            socket.close(1000, "left-room");
          } catch {
            // Already closing.
          }
        }
      }
    }
    if (outcome.closeRoom) {
      await host.retireRoom();
      return;
    }
    if (outcome.committed) {
      await host.rearm();
      // A commit that landed "finished" enqueued the aggregate outbox —
      // flush it off the ack path.
      if (host.booksView()?.state.phase === "finished") {
        host.waitUntil(host.driveOutbox());
        host.waitUntil(host.driveEnding());
      }
      // The commit may have written pending evaluate jobs (accepted post)
      // or opened the settle window (final evaluations) — drive them.
      host.waitUntil(host.driveDecisionJobs());
    }
  } catch (error) {
    sendError(
      host,
      ws,
      codeOf(error),
      error instanceof Error ? error.message : "internal error",
      env.commandId,
    );
  }
};

export const handleClose = (host: SocketHost, ws: WebSocket): void => {
  windows.delete(ws);
  // retireRoom wiped the storage — a close event arriving after teardown
  // must not touch the (now absent) presence tables.
  if (host.isClosed()) return;
  const attachment = attachmentOf(ws);
  if (attachment === null) return;
  // presence.disconnect applies the generation guard itself: a replaced
  // socket's late close event can never kill the new presence.
  commitPresence(host, (h) => disconnect(h, attachment, Date.now()));
};

export const handleError = (host: SocketHost, ws: WebSocket): void => {
  handleClose(host, ws);
};
