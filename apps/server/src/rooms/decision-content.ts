// The DecisionState a job evaluates: real room content — the lobby row is
// locked once the game exists, so the committed prefix read at eval time
// IS the start-time snapshot. Choice ids are the lobby's own (c0..c5) —
// the returned distribution stays keyed to them, which is exactly what
// roomSamples looks up.
import type { GameState, PostedInput } from "@yuragoo/game-core";
import {
  type DecisionState,
  parseChoiceId,
  parseDecisionRevision,
  type RoomLanguage,
} from "@yuragoo/protocol";
import { readLobby } from "./lobby";

// The creature's fixed disposition — rooms author the scenario and the
// committed choices; the persona is the creature itself, not host content.
// Written per room language so the model reads one consistent voice.
const ROOM_PERSONA: Record<RoomLanguage, string> = {
  ja: "素直で気まぐれな生きもの。みんなの言葉に素直に引かれる。",
  en: "An honest, whimsical creature. It is drawn to whatever the group says.",
};

export const buildDecisionState = (
  sql: SqlStorage,
  state: GameState,
  post: PostedInput,
): DecisionState => {
  const lobby = readLobby(sql);
  const language = state.settings.language;
  return {
    revision: parseDecisionRevision(post.seq),
    scenario: lobby.scenario,
    persona: ROOM_PERSONA[language],
    activeContext: state.posts
      .filter((p) => p.seq <= post.seq)
      .slice(-12)
      .map((p) => p.text),
    choices: lobby.choices.slice(0, lobby.committedCount).map((c) => ({
      id: parseChoiceId(c.choiceId),
      label: c.label,
    })),
    language,
  };
};
