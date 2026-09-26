// URL builder seam (Task 36): every room-API/WS/invite URL resolves
// through here so the Discord proxy topology ("<prefix>/api" -> this
// worker, "/" -> this worker) and the ?api= dev override live in one
// place. No fetch logic — callers keep their own transports.

// `?api=<origin>` overrides the worker origin for e2e/dev; production
// and the Discord proxy both run same-origin (empty string).
export const apiOrigin = (): string => new URLSearchParams(window.location.search).get("api") ?? "";

export const apiUrl = (path: string): string => `${apiOrigin()}${path}`;

// Same-origin by default: when the page came from the worker itself
// (production/Discord proxy) the ws URL inherits that host — through the
// Activity proxy this is the *.discordsays.com URL Discord serves.
export const wsUrl = (path: string): string => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const override = apiOrigin();
  const base = override === "" ? `${proto}//${window.location.host}` : override;
  return `${base.replace(/^http/, "ws")}${path}`;
};

// Room page link: keeps the environment params (?api/?hb/?platform) so a
// copied invite lands the invitee on the same topology, minus ?name — a
// shared link must never auto-name its opener.
export const inviteUrl = (roomId: string, inviteSecret: string): string => {
  const params = new URLSearchParams(window.location.search);
  params.delete("name");
  const query = params.toString();
  const sep = query === "" ? "" : `?${query}`;
  return `${window.location.origin}/r/${roomId}${sep}#${inviteSecret}`;
};

// The room path after a platform-join (Discord gate): same origin, with
// the platform marker preserved so the room boots the right adapter.
export const roomPath = (roomId: string): string => {
  const params = new URLSearchParams(window.location.search);
  const query = params.toString();
  return `/r/${roomId}${query === "" ? "" : `?${query}`}`;
};
