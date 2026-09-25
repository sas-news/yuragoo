// Product-side room session helpers (Task 24). Mirrors the e2e bridge's
// sequence — join/recover -> ticket -> ws — but persists the credentials in
// sessionStorage so a reload inside the same tab resumes membership. The
// invite secret only ever travels in the URL fragment; readInviteFragment
// strips it from history the moment it is consumed.
import { eraseInviteSecret, readInviteSecret } from "@yuragoo/platform";
import type { RoomCredentials } from "../net/reconnect";
import { rotateCredentials } from "../net/reconnect";

export interface JoinedSession extends RoomCredentials {
  readonly displayName: string | null;
  readonly lobbyWaiting: boolean;
}

const sessionKey = (roomId: string): string => `yuragoo:room:${roomId}`;
// The display name survives rooms and sessions — the name panel opens
// prefilled with whatever the member used last (localStorage, not
// sessionStorage: it must outlive the tab).
const NAME_KEY = "yuragoo:displayName";

export const loadSavedName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

export const saveName = (name: string): void => {
  try {
    const trimmed = name.trim();
    if (trimmed === "") localStorage.removeItem(NAME_KEY);
    else localStorage.setItem(NAME_KEY, trimmed);
  } catch {
    // Private mode: joining still works for the current visit.
  }
};

export const loadSession = (roomId: string): JoinedSession | null => {
  try {
    const raw = sessionStorage.getItem(sessionKey(roomId));
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object") return null;
    const s = v as JoinedSession;
    return typeof s.playerId === "string" && typeof s.sessionToken === "string" ? s : null;
  } catch {
    return null;
  }
};

export const saveSession = (roomId: string, session: JoinedSession): void => {
  try {
    sessionStorage.setItem(sessionKey(roomId), JSON.stringify(session));
  } catch {
    // Private mode: the page still works for the current visit.
  }
};

// Persist a rotated credential pair over the stored session — the next
// reload must not present the dead pair.
export const saveRotated = (roomId: string, creds: RoomCredentials): void => {
  const existing = loadSession(roomId);
  if (existing === null || existing.playerId !== creds.playerId) return;
  saveSession(roomId, { ...existing, ...creds });
};

export const clearSession = (roomId: string): void => {
  try {
    sessionStorage.removeItem(sessionKey(roomId));
  } catch {
    // Nothing to clear.
  }
};

// `?api=<origin>` overrides the worker origin for e2e/dev; production is
// same-origin. Mirrors the RoomConnection workerOrigin option.
export const apiOrigin = (): string => new URLSearchParams(window.location.search).get("api") ?? "";

// Reads the invite secret out of `#fragment`, then removes the fragment
// from the address bar AND the history entry — the secret is one-shot
// page input, never a bookmark.
export const readInviteFragment = (): string | null => {
  const secret = readInviteSecret(window.location);
  if (secret === null) return null;
  eraseInviteSecret(window.location, window.history);
  return secret;
};

const postJson = async (origin: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorCode = async (res: Response): Promise<Error> => {
  let code = `http-${res.status}`;
  try {
    const b: unknown = await res.json();
    if (b !== null && typeof b === "object" && "error" in b) {
      code = String((b as { error: unknown }).error);
    }
  } catch {
    // Keep the status-derived code.
  }
  return new Error(code);
};

// POST /api/rooms — the home entry's only call. The raw invite secret
// comes back exactly once here; it goes straight into the URL fragment
// and never into storage or another request.
export const createRoom = async (
  origin: string,
): Promise<{ readonly roomId: string; readonly inviteSecret: string }> => {
  const res = await postJson(origin, "/api/rooms", {});
  if (!res.ok) throw await errorCode(res);
  return (await res.json()) as { roomId: string; inviteSecret: string };
};

// POST /api/rooms/:id/join — the invite secret proves membership rights.
export const joinRoom = async (
  origin: string,
  roomId: string,
  inviteSecret: string,
  displayName: string | null,
): Promise<JoinedSession> => {
  const res = await postJson(origin, `/api/rooms/${roomId}/join`, {
    inviteSecret,
    ...(displayName === null ? {} : { displayName }),
  });
  if (!res.ok) throw await errorCode(res);
  const body = (await res.json()) as Omit<JoinedSession, "displayName">;
  return { ...body, displayName };
};

// A stored session whose tokens went stale (tab survived a rotation)
// recovers once through the reconnect route before giving up.
export const recoverSession = async (
  origin: string,
  roomId: string,
  session: JoinedSession,
): Promise<JoinedSession> => {
  const rotated = await rotateCredentials(origin, roomId, session.reconnectToken);
  return { ...session, ...rotated };
};
