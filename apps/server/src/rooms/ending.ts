// The ending table (schema.ts): one row per GAME, written when a match
// finishes. `panel` holds the serialized EndingStory (protocol/story);
// `pose` is reserved for a future server-side pose record and stays NULL —
// panels already embed their canonical pull, and blob images never leave
// the client (story contract).
import { type EndingStory, parseEndingStory } from "@yuragoo/protocol";

type EndingRow = { panel: string | null; pose: string | null };

// Parse-fail-closed: a corrupt row degrades to "no ending" rather than a
// broken snapshot field — the room still serves the plain outcome.
export const readEnding = (sql: SqlStorage): EndingStory | null => {
  const row = sql.exec<EndingRow>("SELECT panel, pose FROM ending WHERE id = 1").toArray()[0];
  if (row === undefined || row.panel === null) return null;
  try {
    return parseEndingStory(JSON.parse(row.panel));
  } catch {
    return null;
  }
};

export const writeEnding = (sql: SqlStorage, story: EndingStory): void => {
  sql.exec(
    "INSERT OR REPLACE INTO ending (id, panel, pose) VALUES (1, ?, NULL)",
    JSON.stringify(story),
  );
};

// Panels are per-game: rematch/backToLobby wipe them with the rest of the
// game's artifacts (clearGameArtifacts) so a stale story never leaks.
export const clearEnding = (sql: SqlStorage): void => {
  sql.exec("DELETE FROM ending");
};
