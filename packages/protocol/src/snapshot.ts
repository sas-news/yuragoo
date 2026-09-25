// Wire shape for the GameState snapshot and the core types nested inside
// it. GameState is already JSON-safe (plain data, no class instances) so
// serialization is a plain stringify; the schemas exist for BOUNDARY
// safety — a client must never trust a frame that does not match, and a
// corrupt persisted snapshot must fail loudly instead of half-parsing.
import { z } from "zod";

const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const postedInputSchema = z.strictObject({
  postId: z.string(),
  playerId: z.string(),
  text: z.string(),
  postedAtMs: z.number(),
  seq: safeInt,
  status: z.enum(["pending", "evaluated"]),
});

export const gameOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("winner"),
    playerId: z.string(),
    slot: safeInt,
  }),
  z.strictObject({ kind: z.literal("draw") }),
  z.strictObject({
    kind: z.literal("noContest"),
    reason: z.enum(["timeout", "aborted", "budget", "pending"]),
  }),
]);

// ResolvedGameSettings — every knob concrete. Bounds are not re-checked
// here: the reducer already enforced them at create time.
export const resolvedSettingsSchema = z.strictObject({
  mode: z.enum(["turn", "live"]),
  seed: z.number().int(),
  rosterSize: z.number().int(),
  devMode: z.boolean(),
  turnSeconds: z.number().int(),
  rounds: z.number().int(),
  liveSeconds: z.number().int(),
  maxPendingPerPlayer: z.number().int(),
  adhesionSeconds: z.number().int(),
  settleSeconds: z.number().int(),
  hostId: z.string(),
  earlyDecision: z.boolean(),
  hostDecision: z.boolean(),
});

export const gameStateSchema = z.strictObject({
  settings: resolvedSettingsSchema,
  phase: z.enum(["lobby", "playing", "complete", "finished"]),
  roster: z.array(z.strictObject({ id: z.string(), slot: safeInt })),
  turnOrder: z.array(z.string()),
  round: safeInt,
  turnIndex: safeInt,
  deadlineAtMs: z.number(),
  posts: z.array(postedInputSchema),
  seq: safeInt,
  startedAtMs: z.number(),
  outcome: gameOutcomeSchema.nullable(),
  adhesion: z.strictObject({ slot: safeInt, sinceMs: z.number() }).nullable(),
  settleCutoffSeq: safeInt.nullable(),
  settleDeadlineAtMs: z.number().nullable(),
  endCause: z.enum(["rounds", "deadline", "dwell", "host"]).nullable(),
  turnPosterId: z.string().nullable(),
});

// Structural twin of game-core's GameState — declared locally so protocol
// never depends on game-core (game-core already depends on protocol).
export interface GameStateSnapshot {
  readonly settings: z.infer<typeof resolvedSettingsSchema>;
  readonly phase: "lobby" | "playing" | "complete" | "finished";
  readonly roster: readonly { readonly id: string; readonly slot: number }[];
  readonly turnOrder: readonly string[];
  readonly round: number;
  readonly turnIndex: number;
  readonly deadlineAtMs: number;
  readonly posts: readonly z.infer<typeof postedInputSchema>[];
  readonly seq: number;
  readonly startedAtMs: number;
  readonly outcome: z.infer<typeof gameOutcomeSchema> | null;
  readonly adhesion: { readonly slot: number; readonly sinceMs: number } | null;
  readonly settleCutoffSeq: number | null;
  readonly settleDeadlineAtMs: number | null;
  readonly endCause: "rounds" | "deadline" | "dwell" | "host" | null;
  readonly turnPosterId: string | null;
}

// GameState -> wire. Plain JSON: the state carries no functions or Dates.
export const serializeGameState = (state: GameStateSnapshot): string => JSON.stringify(state);

// Boundary parse: returns null on any mismatch so callers fail closed.
export const parseGameState = (input: unknown): GameStateSnapshot | null => {
  const result = gameStateSchema.safeParse(input);
  return result.success ? (result.data as GameStateSnapshot) : null;
};

export const parseGameStateJson = (json: string): GameStateSnapshot | null => {
  try {
    return parseGameState(JSON.parse(json));
  } catch {
    return null;
  }
};
