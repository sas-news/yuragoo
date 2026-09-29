// The GameRoom Durable Object — authoritative room host, a thin shell.
import { DurableObject } from "cloudflare:workers";
import { upgradeFetch } from "./admit";
import { commitInitRoom } from "../auth/sessions";
import { presenceTimings, type PresenceTimings, type ServerBindings } from "../config";
import { flushOutbox, resolveOutboxDeps } from "./aggregate-outbox";
import * as alarm from "./alarm";
import * as api from "./api";
import * as authRpc from "./auth-rpc";
import { listRoomPlayers, type RoomPlayer } from "./auth-storage";
import { retryWipeIfPending } from "./close";
import { listDeadlines, minDeadlineRunAt } from "./deadlines";
import { drainDecisionJobs, resolveJobDeps } from "./decision-jobs";
import type { Books } from "./due";
import { kickEnding } from "./ending";
import { type ChoiceGenRequest, runChoiceGeneration } from "./generate-choices";
import { type ScenarioGenRequest, runScenarioGeneration } from "./generate-scenario";
import { resolveGenerationDeps } from "./generation-deps";
import { spendGenerationSlot } from "./generation-slots";
import { resolveLimits, type RoomLimits } from "./limits";
import * as presence from "./presence";
import { loadRoom } from "./recovery";
import { registerActiveRoom } from "./room-registry";
import {
  applyToRoom,
  createRoomAt,
  retireRoomNow,
  sweepLeases as sweepLeasesNow,
} from "./room-ledger";
import { ensureSchema } from "./schema";
import { runStartup } from "./startup";
import type { ApplyResult } from "./storage";
import * as transport from "./transport";
import type { SocketAttachment } from "./wire";

export { RoomError, type ApplyInput, type CreateRoomInit, type RoomSnapshotView } from "./api";

export class GameRoom extends DurableObject<ServerBindings> implements transport.SocketHost {
  private books: Books | null = null;
  private closed = false;
  private readonly timings: PresenceTimings;
  // Single-flight lanes: a drive never overlaps itself inside one isolate.
  private readonly driving = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: ServerBindings) {
    super(ctx, env);
    this.timings = presenceTimings(env);
    ensureSchema(ctx.storage.sql);
    const recovered = loadRoom(ctx.storage);
    if (recovered.kind === "ready") this.books = recovered.room;
    else if (recovered.kind === "closed") this.closed = true;
    runStartup(this, ctx, env, recovered);
  }

  private assertOpen(): void {
    if (this.closed) throw new api.RoomError("room-closed", "room storage is retired");
  }
  // Player-facing entrypoints: open storage inside the empty grace window.
  assertLive(): void {
    this.assertOpen();
    try {
      presence.assertNotExpired(this, Date.now());
    } catch (error) {
      // Crossing the grace boundary must keep the alarm covering it.
      if (error instanceof api.RoomError && error.code === "room-expired") {
        this.ctx.waitUntil(this.rearm().catch(() => {}));
      }
      throw error;
    }
  }

  private openBooks(): Books {
    this.assertOpen();
    if (this.books === null) throw new api.RoomError("not-created", "room is not created");
    return this.books;
  }

  get roomId(): string {
    return this.ctx.id.toString();
  }
  get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }
  storage(): DurableObjectStorage {
    return this.ctx.storage;
  }
  isClosed(): boolean {
    return this.closed;
  }
  markClosed(): void {
    this.closed = true; // terminal — close.ts pairs it with the tombstone
  }
  txn<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
  booksView(): Books | null {
    return this.books;
  }
  setBooks(books: Books | null): void {
    this.books = books;
  }
  roomEpoch(): number {
    return this.books?.meta.gameEpoch ?? 0;
  }
  leaseMs(): number {
    return this.timings.leaseMs;
  }
  emptyGraceMs(): number {
    return this.timings.emptyGraceMs;
  }
  purgeDelayMs(): number {
    return this.timings.purgeDelayMs;
  }
  roomLimits(): RoomLimits {
    return resolveLimits(this.env);
  }
  // ControlPlane active-room bookkeeping — the RPC create path registers
  // inside room-ledger.createRoomAt; the WS path comes through here.
  registerRoom(): void {
    registerActiveRoom(this.ctx, this.env, this.roomId);
  }
  waitUntil(p: Promise<void>): void {
    this.ctx.waitUntil(p);
  }
  sockets(): readonly WebSocket[] {
    return this.ctx.getWebSockets();
  }
  listPlayers(): readonly RoomPlayer[] {
    return listRoomPlayers(this.ctx.storage.sql);
  }
  sweepLeases(): void {
    sweepLeasesNow(this);
  }

  acceptSocket(ws: WebSocket, attachment: SocketAttachment): void {
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment(attachment);
  }
  async rearm(): Promise<void> {
    const min = minDeadlineRunAt(this.ctx.storage.sql);
    // Never push the alarm later — workerd cancels a pending delivery when
    // setAlarm lands mid-flight; an earlier armed time is harmless anyway.
    const armed = await this.ctx.storage.getAlarm();
    if (min === null) {
      if (armed !== null) await this.ctx.storage.deleteAlarm();
    } else if (armed === null || min < armed) await this.ctx.storage.setAlarm(min);
  }

  // --- game ledger RPC (bodies in ./room-ledger) ---

  async createRoom(init: api.CreateRoomInit): Promise<api.CreateRoomResult> {
    return createRoomAt(this, this.ctx, this.env, init);
  }
  async apply(input: api.ApplyInput): Promise<ApplyResult> {
    return applyToRoom(this, input, () => this.driveDecisionJobs());
  }
  private drive(lane: string, start: () => Promise<void>): Promise<void> {
    const current = this.driving.get(lane);
    if (current !== undefined) return current;
    if (this.closed || this.books === null) return Promise.resolve();
    const run = start().finally(() => this.driving.delete(lane));
    this.driving.set(lane, run);
    return run;
  }

  // Task 26: decision runner — a settle tail drives outbox + ending lanes.
  driveDecisionJobs(): Promise<void> {
    return this.drive("jobs", () =>
      drainDecisionJobs(this, resolveJobDeps(this.env)).finally(async () => {
        if (!this.closed && this.books?.state.phase === "finished") {
          this.ctx.waitUntil(this.driveOutbox().catch(() => {}));
          this.ctx.waitUntil(this.driveEnding().catch(() => {}));
        }
        if (!this.closed) await this.rearm().catch(() => {});
      }),
    );
  }
  driveOutbox(): Promise<void> {
    return this.drive("outbox", () => flushOutbox(this, resolveOutboxDeps(this.env)));
  }
  driveEnding(): Promise<void> {
    return this.drive("ending", () => kickEnding(this, resolveGenerationDeps(this.env)));
  }
  retryWipe(): Promise<void> {
    return retryWipeIfPending(this);
  }

  tryGenerationSlot(slot: string): Promise<boolean> {
    this.assertLive();
    return Promise.resolve(spendGenerationSlot(this, slot));
  }

  // Task 25/44: generation commits only an ack; the attempt runs under waitUntil.
  private kickGeneration(run: () => Promise<void>): void {
    this.ctx.waitUntil((this.closed ? Promise.resolve() : run()).catch(() => {}));
  }
  startChoiceGeneration(request: ChoiceGenRequest): void {
    this.kickGeneration(() => runChoiceGeneration(this, resolveGenerationDeps(this.env), request));
  }
  startScenarioGeneration(request: ScenarioGenRequest): void {
    this.kickGeneration(() =>
      runScenarioGeneration(this, resolveGenerationDeps(this.env), request),
    );
  }
  async retireRoom(): Promise<void> {
    await retireRoomNow(this, this.ctx, this.env);
  }

  // --- room-auth RPC (bodies in ./auth-rpc) ---
  initRoom(input: api.InitRoomInput): void {
    this.assertOpen();
    this.ctx.storage.transactionSync(() => commitInitRoom(this.ctx.storage.sql, input));
  }
  async joinRoom(input: api.JoinRoomInput): Promise<api.JoinRoomResult> {
    return authRpc.joinRoomAt(this, input);
  }
  async reconnect(input: api.ReconnectInput): Promise<api.ReconnectResult> {
    return authRpc.reconnectAt(this, input);
  }
  async issueTicket(input: api.IssueTicketInput): Promise<api.IssueTicketResult> {
    return authRpc.issueTicketAt(this, input);
  }
  consumeTicket(input: api.ConsumeTicketInput): api.ConsumeTicketResult {
    return authRpc.consumeTicketAt(this, input);
  }

  override async fetch(request: Request): Promise<Response> {
    return upgradeFetch(this, request);
  }

  // --- hibernation handlers + alarm ---

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await transport.handleMessage(this, ws, message);
  }
  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    transport.handleClose(this, ws);
  }
  override webSocketError(ws: WebSocket, _error: unknown): void {
    transport.handleError(this, ws);
  }
  override async alarm(): Promise<void> {
    await alarm.handleAlarm(this);
  }
  snapshot(): api.RoomSnapshotView {
    this.assertLive();
    return api.buildSnapshotView(this.openBooks(), listDeadlines(this.ctx.storage.sql));
  }
}
