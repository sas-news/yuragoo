// English dictionary, keyed by the JAPANESE source string. Missing keys
// fall back to the key itself — partial coverage never shows a raw key.
// Placeholders use {name}; word order may differ freely per language.
// Room-shared content (scenario presets, generated choices, story text)
// does NOT live here — it follows the room language, not the viewer's.
// Tables are split by surface (./en/*) to stay under the 250-line cap.
import { EN_COMMON } from "./en/common";
import { EN_GAME } from "./en/game";
import { EN_LOBBY } from "./en/lobby";

export const EN: Readonly<Record<string, string>> = { ...EN_COMMON, ...EN_LOBBY, ...EN_GAME };
