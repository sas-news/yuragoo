// Room language (i18n): the ONE language a room's shared text is written
// in — scenario, committed choices and the generated kamishibai are room
// facts everyone reads, so they follow the room, not each viewer's UI
// locale. The lobby settings carry it like the mode switch: a host edit
// bumps the revision, members see the same value before start, and the
// reducer freezes it into GameSettings for the whole match.
import { z } from "zod";

export const roomLanguageSchema = z.enum(["ja", "en"]);
export type RoomLanguage = z.infer<typeof roomLanguageSchema>;
export const ROOM_LANGUAGE_DEFAULT: RoomLanguage = "ja";
