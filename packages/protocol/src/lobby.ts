// Shared lobby ledger shapes (Task 24): the host-editable pre-game
// content — scenario text, per-seat choice drafts and ready flags. The
// server persists a mirror in the GameRoom `lobby` table; these schemas
// are the wire boundary for the snapshot field, the lobbyChanged event
// and the updateLobbyContent command. Grapheme limits come from
// docs/game-rules.md (scenario <= 1000, choice label <= 40, display name
// <= 24) and count via Intl.Segmenter like every other text bound.
import { z } from "zod";
import { countGraphemes } from "./text";

export const SCENARIO_MAX_GRAPHEMES = 1000;
export const CHOICE_LABEL_MAX_GRAPHEMES = 40;
// The arena seats at most six players — the choice ledger and AI
// generation are bounded by it (prep rows beyond the member count are
// orphan drafts that activate as members join).
export const LOBBY_SEAT_COUNT = 6;

const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// A length-only grapheme cap; empty text is allowed (blank drafts block
// startGame, never the edit itself — the host needs a free scratchpad).
const graphemeCap = (max: number) =>
  z.string().superRefine((value, ctx) => {
    const graphemes = countGraphemes(value);
    if (graphemes > max) {
      ctx.addIssue({
        code: "custom",
        message: "TextTooLong",
        input: value,
        params: { reason: "too-long", graphemes, max },
      });
    }
  });

export const scenarioTextSchema = graphemeCap(SCENARIO_MAX_GRAPHEMES);
export const choiceLabelSchema = graphemeCap(CHOICE_LABEL_MAX_GRAPHEMES);

// One choice draft row. choiceId is server-assigned at growth time (never
// derived from the label) and stable across edits/member-count changes.
export const lobbyChoiceSchema = z.strictObject({
  choiceId: z.string().min(1).max(64),
  label: z.string(),
});
export type LobbyChoice = z.infer<typeof lobbyChoiceSchema>;

// The pre-game settings every member sees (Task 26): the effective values
// the next game starts with — mode, the mode-relevant durations, and the
// two optional early-end switches. Derived from the persisted lobby
// settings patch at read time (never a host-only side channel); the
// startGame payload may only confirm these, never contradict them.
export const lobbySettingsViewSchema = z.strictObject({
  mode: z.enum(["turn", "live"]),
  turnSeconds: z.literal([10, 20, 30, 45, 60]),
  rounds: z.number().int().min(1).max(8),
  liveSeconds: z.literal([60, 120, 180, 300, 600]),
  earlyDecision: z.boolean(),
  hostDecision: z.boolean(),
});
export type LobbySettingsView = z.infer<typeof lobbySettingsViewSchema>;

// What a fresh lobby shows before the host touches anything — the same
// values validateSettings resolves by default.
export const LOBBY_SETTINGS_DEFAULT: LobbySettingsView = {
  mode: "turn",
  turnSeconds: 20,
  rounds: 3,
  liveSeconds: 120,
  earlyDecision: false,
  hostDecision: false,
};

// The ledger's wire/read model — identical for the snapshot `lobby` field
// and the lobbyChanged broadcast. committedCount is 0 until startGame
// lands; then it records how many leading choices the game committed.
export const lobbyStateSchema = z.strictObject({
  revision: safeInt,
  scenario: z.string(),
  choices: z.array(lobbyChoiceSchema),
  ready: z.array(z.string()),
  committedCount: safeInt,
  // Task 25: the one-shot pre-game AI generation slot was spent. Derived
  // from the generation_slots ledger at read time (not a stored column).
  generationSpent: z.boolean(),
  // Task 44: the one-shot scenario (お題) generation slot, same ledger.
  scenarioSpent: z.boolean(),
  // Task 26: the shared mode/ending settings — identical on every member's
  // screen; a host edit bumps revision and clears `ready` in the same
  // broadcast.
  settings: lobbySettingsViewSchema,
});
export type LobbyState = z.infer<typeof lobbyStateSchema>;

// updateLobbyContent payload, factored so the server's dispatch and the
// client's committer share one shape. choices entries are PARTIAL row
// edits keyed by the stable choiceId — unknown ids are rejected
// server-side, rows never shrink or reorder through this command.
export const updateLobbyContentPayloadSchema = z.strictObject({
  scenario: scenarioTextSchema.optional(),
  choices: z
    .array(z.strictObject({ choiceId: z.string().min(1).max(64), label: choiceLabelSchema }))
    .max(24)
    .optional(),
  expectedLobbyRevision: safeInt,
});
export type UpdateLobbyContentPayload = z.infer<typeof updateLobbyContentPayloadSchema>;

// The distinct-labels start gate compares NFKC-folded, trimmed text so
// visually identical labels can never reach the arena.
export const labelKey = (label: string): string => label.normalize("NFKC").trim();
