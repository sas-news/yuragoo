// Browser platform adapter: invite secrets ride the URL fragment, get read
// once client-side, then erased from history before any network call. The
// helpers here are pure — they take the DOM pieces they touch as minimal
// structural interfaces so this file compiles without DOM lib and stays
// unit-testable.
import type { JoinRequest, PlatformAdapter } from "./adapter";

// The DOM surface this adapter needs — deliberately a subset of Location.
export interface LocationLike {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string): void;
}

// Reads the invite secret out of `#<secret>`; returns null when the
// fragment is absent or empty so callers can distinguish "no invite".
export const readInviteSecret = (location: { readonly hash: string }): string | null => {
  const hash = location.hash;
  if (hash.length <= 1) return null;
  const secret = hash.slice(1);
  return secret.length > 0 ? secret : null;
};

// Drops the fragment from the address bar without a navigation — the
// secret must not linger in history, referrers or copied URLs.
export const eraseInviteSecret = (
  location: { readonly pathname: string; readonly search: string },
  history: HistoryLike,
): void => {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
};

// The only place a raw invite secret is allowed into a URL: the fragment.
// Task 24: /r/<roomId> is the product room route — invitees land in the
// lobby, the secret never reaches a path or a query string.
export const buildInviteUrl = (roomId: string, inviteSecret: string): string =>
  `/r/${roomId}#${inviteSecret}`;

export const BrowserAdapter: PlatformAdapter = {
  kind: "browser",
  createPath: "/api/rooms",
  joinPath: (roomId) => `/api/rooms/${roomId}/join`,
  reconnectPath: (roomId) => `/api/rooms/${roomId}/reconnect`,
  ticketPath: (roomId) => `/api/rooms/${roomId}/ticket`,
  wsPath: (roomId, ticket) => `/api/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`,
  joinBody: (inviteSecret, displayName): JoinRequest =>
    displayName === undefined ? { inviteSecret } : { inviteSecret, displayName },
  reconnectBody: (reconnectToken) => ({ reconnectToken }),
  ticketBody: (sessionToken) => ({ sessionToken }),
};
