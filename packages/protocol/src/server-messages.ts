// Room -> client server envelopes (Task 19). Every frame the room sends is
// `{protocolVersion, eventSeq, stateRevision, gameId, gameEpoch, serverTime,
// type, payload}`. eventSeq is the persisted events-table seq (==
// state_revision for that event); clients detect gaps in it and resync via
// syncRequest -> snapshot. stateRevision/gameEpoch ride every frame so a
// client can always tell which game generation a frame belongs to.
import { z } from "zod";
import { choiceIdSchema } from "./ids";
import { lobbyStateSchema } from "./lobby";
import { gameOutcomeSchema, gameStateSchema, postedInputSchema } from "./snapshot";
import { endingStorySchema } from "./story";

const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// The persisted game-core GameEvent union (rooms/storage events.payload).
export const gameEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("started"),
    roster: z.array(z.strictObject({ id: z.string(), slot: safeInt })),
  }),
  z.strictObject({ type: z.literal("turn"), round: safeInt, playerId: z.string() }),
  z.strictObject({ type: z.literal("passed"), playerId: z.string() }),
  z.strictObject({ type: z.literal("posted"), postId: z.string(), playerId: z.string() }),
  z.strictObject({ type: z.literal("complete"), cutoffSeq: safeInt, cause: z.string() }),
  z.strictObject({ type: z.literal("end-requested"), playerId: z.string() }),
  z.strictObject({ type: z.literal("finished"), outcome: gameOutcomeSchema }),
]);
export type WireGameEvent = z.infer<typeof gameEventSchema>;

export const roomPlayerViewSchema = z.strictObject({
  playerId: z.string(),
  joinOrder: safeInt,
  displayName: z.string().nullable(),
  lobbyWaiting: z.boolean(),
  // Task 20: derived from the heartbeat lease at snapshot-build time.
  connected: z.boolean(),
});
export type RoomPlayerView = z.infer<typeof roomPlayerViewSchema>;

const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({
    protocolVersion: z.number().int(),
    eventSeq: safeInt,
    stateRevision: safeInt,
    gameId: z.string(),
    gameEpoch: safeInt,
    serverTime: z.number(),
    type: z.literal(type),
    payload,
  });

const eventPayload = z.strictObject({
  event: gameEventSchema,
  phase: z.enum(["lobby", "playing", "complete", "finished"]),
});

export const serverEnvelopeSchema = z.discriminatedUnion("type", [
  // Full resync point: entire GameState + lobby ledger, sent on connect and
  // as the syncRequest reply. eventSeq == stateRevision.
  envelope(
    "snapshot",
    z.strictObject({
      state: gameStateSchema.nullable(),
      phase: z.enum(["lobby", "playing", "complete", "finished"]),
      inputSeq: safeInt,
      players: z.array(roomPlayerViewSchema),
      // The room's elected host (Task 20) — authority follows this, not
      // the original creator. Null when nobody ever connected.
      hostPlayerId: z.string().nullable(),
      // Task 24: the shared lobby ledger (scenario/choices/ready). Always
      // present — an untouched lobby reads revision 0 with empty content.
      lobby: lobbyStateSchema,
      // Landed decision distributions keyed by postId — a joining or
      // reconnecting client rebuilds the creature's pull without
      // replaying the event ledger.
      decisions: z
        .record(
          z.string(),
          z.array(z.strictObject({ choiceId: choiceIdSchema, probability: z.number() })),
        )
        .optional(),
      // Task 32: the persisted kamishibai ending — a reconnecting client
      // must heal panels from the snapshot because ordered frames older
      // than the healed revision are never replayed.
      ending: endingStorySchema.nullable().optional(),
    }),
  ),
  // The sender's receipt for one accepted commandId (dedupe-replayed intact).
  envelope(
    "ack",
    z.strictObject({
      commandId: z.string(),
      accepted: z.literal(true),
      inputSeq: safeInt,
      stateRevision: safeInt,
    }),
  ),
  // A post was accepted; `post` carries the text the GameEvent omits.
  envelope("inputAccepted", eventPayload.extend({ post: postedInputSchema.optional() })),
  envelope("phaseChanged", eventPayload),
  // AI decision payloads are owned by a later task; shape reserved.
  envelope(
    "decisionUpdated",
    z.strictObject({
      postId: z.string().optional(),
      revision: safeInt.optional(),
      distribution: z
        .array(z.strictObject({ choiceId: choiceIdSchema, probability: z.number() }))
        .optional(),
    }),
  ),
  // A decision job died terminally (config missing, cap denied, upstream
  // failed twice, orphan suppressed) — the post stays pending forever, so
  // the feed must SAY the eval is never coming instead of going silent.
  envelope("decisionFailed", z.strictObject({ postId: z.string(), code: z.string() })),
  envelope("hostChanged", z.strictObject({ playerId: z.string() })),
  envelope("presenceChanged", z.strictObject({ playerId: z.string(), connected: z.boolean() })),
  // Task 24: the shared lobby ledger changed (host edit, choice growth on
  // join, ready flip, start commit). Payload is the full new ledger — it
  // is small enough that deltas would only add failure modes.
  envelope("lobbyChanged", lobbyStateSchema),
  // A finished game returned to the lobby (backToLobby) — payload is the
  // reopened ledger (ready flags reset). Distinct from lobbyChanged so
  // clients can drop the dead game view instead of just re-rendering it.
  envelope("lobbyReopened", lobbyStateSchema),
  // Task 24: membership ledger changes so every client can rebuild the
  // roster without a resync. memberJoined carries the same view the
  // snapshot's players list uses; memberLeft names the departed id.
  envelope("memberJoined", roomPlayerViewSchema),
  envelope("memberLeft", z.strictObject({ playerId: z.string() })),
  // Task 25: one-shot AI choice generation outcome. The proposal carries
  // the lobbyRevision captured at request time — applying always goes
  // through updateLobbyContent on the CURRENT revision, so a moved lobby
  // is never silently overwritten. generationFailed says whether the
  // attempt consumed the slot (post-send failures do; pre-send denials
  // do not, and the button stays usable).
  envelope(
    "choicesGenerated",
    z.strictObject({
      lobbyRevision: safeInt,
      memberCount: safeInt,
      labels: z.array(z.string()).max(24),
    }),
  ),
  envelope(
    "generationFailed",
    z.strictObject({
      code: z.string(),
      message: z.string(),
      slotSpent: z.boolean(),
    }),
  ),
  // Task 31/32: the game's kamishibai panel set. Fires once right after
  // finish with template text, then again once the post-game generation
  // call lands (or the row just stays at generated:false on failure).
  envelope("endingReady", endingStorySchema),
  envelope("roomClosed", z.strictObject({ reason: z.string() })),
  // Rejections are frames, not closes (except oversized frames, which close
  // 1009 after this frame). commandId echoes the rejected command when known.
  envelope(
    "error",
    z.strictObject({
      code: z.string(),
      message: z.string(),
      commandId: z.string().optional(),
    }),
  ),
]);

export type ServerEnvelope = z.infer<typeof serverEnvelopeSchema>;
export type ServerEnvelopeType = ServerEnvelope["type"];
export type SnapshotPayload = Extract<ServerEnvelope, { type: "snapshot" }>["payload"];
export type AckPayload = Extract<ServerEnvelope, { type: "ack" }>["payload"];
export type ErrorPayload = Extract<ServerEnvelope, { type: "error" }>["payload"];

export const parseServerEnvelope = (input: unknown): ServerEnvelope | null => {
  const result = serverEnvelopeSchema.safeParse(input);
  return result.success ? result.data : null;
};
