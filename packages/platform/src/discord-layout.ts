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

const pickMode = (data: unknown): LayoutMode => {
  const s = String(record(data)?.layout_mode ?? "").toLowerCase();
  if (s.includes("pip")) return "pip";
  if (s.includes("grid")) return "grid";
  if (s.includes("focus")) return "focused";
  return "unknown";
};

const pickOrientation = (data: unknown): Orientation => {
  const s = String(record(data)?.orientation ?? data ?? "").toLowerCase();
  return s.includes("portrait") ? "portrait" : s.includes("landscape") ? "landscape" : "unknown";
};

const pickThermal = (data: unknown): ThermalState => {
  const s = String(record(data)?.thermal_state ?? "").toLowerCase();
  if (s.includes("critical")) return "critical";
  if (s.includes("serious")) return "serious";
  if (s.includes("fair")) return "fair";
  return s.includes("normal") ? "normal" : "unknown";
};

export interface LayoutWatcher {
  readonly state: LayoutState;
  readonly participantCount: number | null;
  stop(): void;
}

// Subscribe to all three environment events with one listener bundle.
// onChange fires after every event so callers re-render once per update.
export const watchLayout = (
  sdk: DiscordSdkLike,
  onChange: (state: LayoutState) => void,
  onParticipants?: (count: number) => void,
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
      participantCount = Array.isArray(list) ? list.length : participantCount;
      if (participantCount !== null) onParticipants(participantCount);
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
