// Host edit drafts for the shared lobby (Task 24), extracted from Lobby
// for the size cap — same behavior: debounced saves ride the current
// revision; a focused/dirty field is NEVER overwritten by an incoming
// lobbyChanged. Clean fields adopt the server value; dirty fields keep
// the local text and flag 他の変更あり until the server echoes it back
// (which drops the draft). A stale-revision rejection retries a bounded
// number of times on the fresh revision before giving up to the user.
import { useEffect, useRef, useState } from "react";
import type { LobbyState } from "@yuragoo/protocol";

export interface Draft {
  readonly value: string;
  readonly conflict: boolean;
}

export type SendLobbyPatch = (
  patch: {
    scenario?: string;
    choices?: Array<{ choiceId: string; label: string }>;
  },
  expectedLobbyRevision: number,
) => Promise<unknown> | undefined;

const DEBOUNCE_MS = 350; // debounced-with-revision save cadence
const RETRY_MS = 200; // bounded re-send after a revision conflict

export function useLobbyDrafts(
  lobby: LobbyState,
  sendPatch: SendLobbyPatch,
  onSendError: (message: string) => void,
): {
  readonly drafts: Record<string, Draft>;
  readonly fieldValue: (key: string, server: string) => string;
  readonly fieldConflict: (key: string) => boolean;
  readonly onEdit: (key: string, value: string) => void;
} {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, string>());
  const retries = useRef(new Map<string, number>());
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;

  // Merge incoming ledger into drafts: identical server value -> the edit
  // landed, drop the draft; a divergent value on a still-dirty field ->
  // keep local text, flag 他の変更あり. Server never deletes choice rows,
  // so a missing row just drops the draft defensively.
  useEffect(() => {
    setDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const server =
          key === "scenario"
            ? lobby.scenario
            : lobby.choices.find((c) => c.choiceId === key)?.label;
        const draft = next[key];
        if (draft === undefined) continue;
        if (server === draft.value || server === undefined) {
          delete next[key];
          pending.current.delete(key);
          changed = true;
        } else if (!draft.conflict) {
          next[key] = { ...draft, conflict: true };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [lobby]);

  const flush = (key: string): void => {
    const value = pending.current.get(key);
    if (value === undefined) return;
    const server =
      key === "scenario"
        ? lobbyRef.current.scenario
        : lobbyRef.current.choices.find((c) => c.choiceId === key)?.label;
    if (server === value) {
      pending.current.delete(key);
      return; // already landed — a resend would only bump the revision
    }
    const patch =
      key === "scenario" ? { scenario: value } : { choices: [{ choiceId: key, label: value }] };
    void sendPatch(patch, lobbyRef.current.revision)?.catch((e: Error) => {
      if (e.message.startsWith("lobby-revision-conflict")) {
        // Someone else's revision landed first — keep the draft, flag it,
        // and retry a bounded number of times on the fresh revision.
        const tries = (retries.current.get(key) ?? 0) + 1;
        retries.current.set(key, tries);
        setDrafts((d) =>
          d[key] === undefined ? d : { ...d, [key]: { ...d[key], conflict: true } },
        );
        if (tries <= 5)
          timers.current.set(
            key,
            setTimeout(() => flush(key), RETRY_MS),
          );
      } else {
        onSendError(e.message);
      }
    });
  };

  const onEdit = (key: string, value: string): void => {
    retries.current.delete(key);
    pending.current.set(key, value);
    setDrafts((d) => ({ ...d, [key]: { value, conflict: false } }));
    clearTimeout(timers.current.get(key));
    timers.current.set(
      key,
      setTimeout(() => flush(key), DEBOUNCE_MS),
    );
  };

  return {
    drafts,
    fieldValue: (key, server) => drafts[key]?.value ?? server,
    fieldConflict: (key) => drafts[key]?.conflict ?? false,
    onEdit,
  };
}
