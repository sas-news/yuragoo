// Client -> room command envelopes (Task 19). Every command rides one
// envelope: `{protocolVersion, commandId, gameId, expectedGameEpoch, type,
// payload}`. commandId is the idempotency key (deduped server-side per
// player); expectedGameEpoch pins the game generation the client last saw
// — a stale epoch is rejected so the client resyncs instead of writing
// into a new game blind. The server NEVER trusts payload-declared
// identity: playerId/host come from the WebSocket attachment.
import { z } from "zod";
import { updateLobbyContentPayloadSchema } from "./lobby";
import { postTextSchema } from "./text";

const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Host-tunable lobby knobs for startGame/updateLobby (Task 26 contract).
// TURN/LIVE durations are fixed menus — schema-external numbers never
// reach the room. game-core re-validates authoritatively at create;
// rosterSize/hostId/playerIds are deliberately absent — the room derives
// them from the membership ledger and the connection.
export const lobbySettingsSchema = z.strictObject({
  mode: z.enum(["turn", "live"]).optional(),
  seed: z.number().int().optional(),
  turnSeconds: z.literal([10, 20, 30, 45, 60]).optional(),
  rounds: z.number().int().min(1).max(8).optional(),
  liveSeconds: z.literal([60, 120, 180, 300, 600]).optional(),
  maxPendingPerPlayer: z.number().int().min(1).max(4).optional(),
  adhesionSeconds: z.number().int().min(1).max(60).optional(),
  settleSeconds: z.number().int().min(1).max(30).optional(),
  // Optional pre-game switches; both ride the public lobby settings so
  // every member sees them before start.
  earlyDecision: z.boolean().optional(),
  hostDecision: z.boolean().optional(),
});
export type LobbySettings = z.infer<typeof lobbySettingsSchema>;

const emptyPayload = z.strictObject({});

const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({
    protocolVersion: z.number().int().min(1),
    commandId: z.string().min(1).max(64),
    gameId: z.string().min(1).max(128),
    expectedGameEpoch: safeInt,
    type: z.literal(type),
    payload,
  });

export const clientEnvelopeSchema = z.discriminatedUnion("type", [
  // An in-game text submission -> game-core `post` for the connection's
  // playerId. A payload-declared playerId is accepted by the schema but
  // never read — identity always comes from the socket attachment.
  envelope("submitText", z.strictObject({ text: postTextSchema, playerId: z.string().optional() })),
  // TURN-mode voluntary skip by the current turn player (server-side guard).
  envelope("pass", emptyPayload),
  // Host-only: creates (or starts) the game; payload may carry lobby settings.
  envelope("startGame", lobbySettingsSchema),
  // Pre-game lobby settings patch; applied when the game is created.
  envelope("updateLobby", lobbySettingsSchema),
  // Task 24: host-only edit of the shared lobby content (scenario +
  // per-seat choice drafts), guarded by expectedLobbyRevision — a stale
  // revision is rejected as lobby-revision-conflict and nothing writes.
  envelope("updateLobbyContent", updateLobbyContentPayloadSchema),
  // Task 24: any member's own ready flag; the start gate requires every
  // non-lobbyWaiting member to be ready.
  envelope("setReady", z.strictObject({ ready: z.boolean() })),
  // Task 25: host-only one-shot AI choice generation. Empty payload — the
  // server captures scenario/member count/lobbyRevision itself; the
  // proposal arrives later as a choicesGenerated event.
  envelope("generateChoices", emptyPayload),
  // Task 24: self-removal from the room membership. Roster members are
  // refused mid-game (lobby-waiting joiners may still leave); leaving
  // shrinks the member count and orphans the trailing choice drafts.
  envelope("leave", emptyPayload),
  // Host-only early-end request -> game-core `request-end`.
  envelope("requestDecision", emptyPayload),
  // New game inside the same room from a finished result screen; epoch+1.
  envelope("rematch", emptyPayload),
  // Any member: a finished room returns to the shared lobby instead of
  // auto-restarting — the ledger survives, ready flags reset, and the next
  // startGame is a fresh epoch. Replaces rematch's instant restart UX.
  envelope("backToLobby", emptyPayload),
  // Host-only: hand the host seat to another connected member mid-lobby
  // or mid-game (in-game host authority retargets with the election).
  envelope("transferHost", z.strictObject({ playerId: z.string().min(1).max(64) })),
  // Host-only room close -> roomClosed broadcast, then teardown.
  envelope("closeRoom", emptyPayload),
  // Presence touch; minimal side effects until the presence task lands.
  envelope("heartbeat", emptyPayload),
  // Discord-only presence report (Task 48): the reporter forwards the
  // instance's ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE user-id list so the
  // room can mark verified Discord members who left the Activity as
  // disconnected — their zombie iframe keeps the socket/lease alive.
  envelope(
    "reportParticipants",
    z.strictObject({ userIds: z.array(z.string().min(1).max(64)).max(64) }),
  ),
  // Gap resync: the server replies with a full `snapshot` frame.
  envelope("syncRequest", z.strictObject({ lastEventSeq: safeInt.optional() })),
]);

export type ClientEnvelope = z.infer<typeof clientEnvelopeSchema>;
export type ClientCommandType = ClientEnvelope["type"];

export const parseClientEnvelope = (input: unknown): ClientEnvelope | null => {
  const result = clientEnvelopeSchema.safeParse(input);
  return result.success ? result.data : null;
};
