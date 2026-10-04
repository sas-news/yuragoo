// Activity layout/subscription helpers (Task 34): layout-mode,
// orientation, thermal and participant events all arrive through the same
// subscribe/unsubscribe pair; this module narrows the payloads and owns
// cleanup so a screen that unmounts stops hearing the SDK immediately.
import type { DiscordSdkLike, DiscordSubscription } from "./discord";

// Events the game cares about. Mirrors the EventSchema names in the SDK,
// redeclared as literals so this file stays independent of the package.
export const DISCORD_EVENTS = {
  layoutMode: "ACTIVITY_LAYOUT_MODE_UPDATE",
  orientation: "ORIENTATION_UPDATE",
  thermal: "THERMAL_STATE_UPDATE",
  participants: "ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE",
} as const;

export type LayoutMode = "focused" | "pip" | "grid" | "unknown";
export type Orientation = "landscape" | "portrait" | "unknown";
export type ThermalState = "normal" | "fair" | "serious" | "critical" | "unknown";

export interface LayoutState {
  readonly mode: LayoutMode;
  readonly orientation: Orientation;
  readonly thermal: ThermalState;
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

// Discord sends these payloads as small-int enums (LayoutModeTypeObject /
// OrientationTypeObject / ThermalStateTypeObject in the SDK schema):
//   layout_mode   FOCUSED=0 PIP=1 GRID=2 UNHANDLED=-1
//   orientation   PORTRAIT=0 LANDSCAPE=1 UNHANDLED=-1
//   thermal_state NOMINAL=0 FAIR=1 SERIOUS=2 CRITICAL=3 UNHANDLED=-1
// String forms are kept as a defensive fallback only — a bare String()
// parse silently turned every real event into "unknown".
const LAYOUT_MODES: Record<number, LayoutMode> = { 0: "focused", 1: "pip", 2: "grid" };
const pickMode = (data: unknown): LayoutMode => {
  const v = record(data)?.layout_mode;
  if (typeof v === "number") return LAYOUT_MODES[v] ?? "unknown";
  const s = String(v ?? "").toLowerCase();
  if (s.includes("pip")) return "pip";
  if (s.includes("grid")) return "grid";
  return s.includes("focus") ? "focused" : "unknown";
};

const ORIENTATIONS: Record<number, Orientation> = { 0: "portrait", 1: "landscape" };
const pickOrientation = (data: unknown): Orientation => {
  const v = record(data)?.orientation ?? data;
  if (typeof v === "number") return ORIENTATIONS[v] ?? "unknown";
  const s = String(v ?? "").toLowerCase();
  return s.includes("portrait") ? "portrait" : s.includes("landscape") ? "landscape" : "unknown";
};

const THERMALS: Record<number, ThermalState> = {
  0: "normal",
  1: "fair",
  2: "serious",
  3: "critical",
};
const pickThermal = (data: unknown): ThermalState => {
  const v = record(data)?.thermal_state;
  if (typeof v === "number") return THERMALS[v] ?? "unknown";
  const s = String(v ?? "").toLowerCase();
  if (s.includes("critical")) return "critical";
  if (s.includes("serious")) return "serious";
  if (s.includes("fair")) return "fair";
  return s.includes("normal") || s.includes("nominal") ? "normal" : "unknown";
};

export interface LayoutWatcher {
  readonly state: LayoutState;
  readonly participantCount: number | null;
  stop(): void;
}

// Subscribe to all three environment events with one listener bundle.
// onChange fires after every event so callers re-render once per update.
// onParticipants receives the instance's Discord user-id list (Task 48) —
// the room uses it to spot members who left the Activity entirely.
export const watchLayout = (
  sdk: DiscordSdkLike,
  onChange: (state: LayoutState) => void,
  onParticipants?: (userIds: readonly string[]) => void,
): LayoutWatcher => {
  const current = {
    mode: "unknown" as LayoutMode,
    orientation: "unknown" as Orientation,
    thermal: "normal" as ThermalState,
  };
  const subs: DiscordSubscription[] = [];
  let participantCount: number | null = null;

  const add = (event: string, listener: (data: unknown) => unknown): void => {
    try {
      void Promise.resolve(sdk.subscribe(event, listener)).then(() => {
        subs.push({ off: () => void sdk.unsubscribe(event, listener) });
      });
    } catch {
      // A host client missing an event skips the subscription — the game
      // still runs, just without that signal.
    }
  };

  add(DISCORD_EVENTS.layoutMode, (data) => {
    current.mode = pickMode(data);
    onChange({ ...current });
  });
  add(DISCORD_EVENTS.orientation, (data) => {
    current.orientation = pickOrientation(data);
    onChange({ ...current });
  });
  add(DISCORD_EVENTS.thermal, (data) => {
    current.thermal = pickThermal(data);
    onChange({ ...current });
  });
  if (onParticipants !== undefined) {
    add(DISCORD_EVENTS.participants, (data) => {
      const list = record(data)?.participants;
      if (!Array.isArray(list)) return;
      participantCount = list.length;
      // Each entry carries the verified Discord user id (snowflake) —
      // non-string members are dropped defensively, never invented.
      onParticipants(
        list
          .map((p) => record(p)?.id)
          .filter((id): id is string => typeof id === "string" && id !== ""),
      );
    });
  }

  return {
    get state() {
      return current;
    },
    get participantCount() {
      return participantCount;
    },
    stop() {
      for (const s of subs.splice(0)) s.off();
    },
  };
};
