// Slot identity helpers shared by the HUD and feed. Identity is
// symbol + letter + spatial slot (DESIGN.md §4) — the color chip is a
// redundant accent only, never the sole carrier of meaning.

export const SLOT_SYMBOLS = ["○", "◇", "△", "□", "☆", "⬡"] as const;
export const SLOT_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

// Warm-pastel accents that read on the paper background.
const SLOT_COLORS = ["#2fa98b", "#e0709a", "#f0a03c", "#5f7fdb", "#8f6fd8", "#58b364"] as const;

export const slotBadge = (slot: number): string =>
  `${SLOT_SYMBOLS[slot] ?? "?"}${SLOT_LETTERS[slot] ?? "?"}`;

export const slotColor = (slot: number): string => SLOT_COLORS[slot] ?? "#715e6b";
