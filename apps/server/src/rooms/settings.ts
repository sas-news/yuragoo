// Lobby settings authority (Task 26): the host's mode/ending choices are
// persisted as a JSON patch in `lobby_settings`, and the PUBLIC view rides
// the lobby ledger so every member sees the same values — no host-only
// channel. The stored JSON is sanitized field-by-field at the read
// boundary, so a stale or corrupt row degrades to defaults instead of
// smuggling out-of-contract knobs into a game.
import type { GameSettings } from "@yuragoo/game-core";
import {
  LOBBY_SETTINGS_DEFAULT,
  lobbySettingsSchema,
  type LobbySettings,
  type LobbySettingsView,
} from "@yuragoo/protocol";
import { readLobbySettings, writeLobbySettings } from "./auth-storage";
import { CommandError } from "./wire";

// The display fields every member sees — a startGame payload may confirm
// them but never contradict them; everything else (seed, settle window…)
// is a non-display knob the host payload may still carry.
const DISPLAY_KEYS = [
  "mode",
  "turnSeconds",
  "rounds",
  "liveSeconds",
  "earlyDecision",
  "hostDecision",
  "language",
] as const;

type FieldCheck = { safeParse: (value: unknown) => { success: boolean } };
const fieldChecks = lobbySettingsSchema.shape as unknown as Record<string, FieldCheck>;

// Per-field wire validation: each stored value must satisfy the client
// schema on its own or it is dropped — a partially-corrupt row can never
// poison the merge, the public view or the create settings.
const sanitizePatch = (raw: unknown): LobbySettings => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const check = fieldChecks[key];
    if (check?.safeParse(value).success === true) out[key] = value;
  }
  return out as LobbySettings;
};

// The stored patch, sanitized. Corrupt/absent JSON -> {}.
export const readLobbyPatch = (sql: SqlStorage): LobbySettings => {
  const raw = readLobbySettings(sql);
  if (raw === null) return {};
  try {
    return sanitizePatch(JSON.parse(raw));
  } catch {
    return {};
  }
};

// The view every member sees. Sanitized input + explicit defaults keep
// every returned field contract-valid even for a weird stored row.
export const lobbySettingsView = (patch: LobbySettings): LobbySettingsView => ({
  mode: patch.mode ?? LOBBY_SETTINGS_DEFAULT.mode,
  turnSeconds: patch.turnSeconds ?? LOBBY_SETTINGS_DEFAULT.turnSeconds,
  rounds: patch.rounds ?? LOBBY_SETTINGS_DEFAULT.rounds,
  liveSeconds: patch.liveSeconds ?? LOBBY_SETTINGS_DEFAULT.liveSeconds,
  earlyDecision: patch.earlyDecision === true,
  hostDecision: patch.hostDecision === true,
  language: patch.language ?? LOBBY_SETTINGS_DEFAULT.language,
});

// Settings for game create: the display fields come ONLY from the shared
// lobby view — what every member saw — never from the payload
// (assertStartPayloadVisible already proved they agree). Non-display
// knobs (seed/settle window/…) merge stored-patch then payload.
// rosterSize and hostId are always server-derived and can never arrive
// from the client.
export const resolveCreateSettings = (
  sql: SqlStorage,
  payload: LobbySettings,
  rosterSize: number,
  hostId: string,
): GameSettings => {
  const patch = { ...readLobbyPatch(sql), ...payload };
  const view = lobbySettingsView(readLobbyPatch(sql));
  return {
    mode: view.mode,
    seed: patch.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    rosterSize,
    hostId,
    turnSeconds: view.turnSeconds,
    rounds: view.rounds,
    liveSeconds: view.liveSeconds,
    earlyDecision: view.earlyDecision,
    hostDecision: view.hostDecision,
    language: view.language,
    ...(patch.maxPendingPerPlayer === undefined
      ? {}
      : { maxPendingPerPlayer: patch.maxPendingPerPlayer }),
    ...(patch.adhesionSeconds === undefined ? {} : { adhesionSeconds: patch.adhesionSeconds }),
    ...(patch.settleSeconds === undefined ? {} : { settleSeconds: patch.settleSeconds }),
  };
};

// Merge an updateLobby payload into the stored patch. Returns null when
// the effective patch is unchanged — a true no-op must not clear ready
// flags or broadcast a redundant lobbyChanged.
export const mergeLobbyPatch = (sql: SqlStorage, patch: LobbySettings): LobbySettings | null => {
  const stored = readLobbyPatch(sql);
  const merged = sanitizePatch({ ...stored, ...patch });
  return JSON.stringify(merged) === JSON.stringify(stored) ? null : merged;
};

export const writeLobbyPatch = (sql: SqlStorage, patch: LobbySettings): void =>
  writeLobbySettings(sql, JSON.stringify(patch));

// The game starts with exactly the settings everyone saw: every payload
// display field must equal the lobby view — updateLobby first, never a
// hidden switch inside startGame.
export const assertStartPayloadVisible = (sql: SqlStorage, payload: LobbySettings): void => {
  const view = lobbySettingsView(readLobbyPatch(sql));
  for (const key of DISPLAY_KEYS) {
    const want = payload[key];
    if (want !== undefined && want !== view[key]) {
      throw new CommandError(
        "settings-mismatch",
        `startGame ${key}=${String(want)} differs from the lobby's ${String(view[key])}; change it with updateLobby first`,
      );
    }
  }
};
