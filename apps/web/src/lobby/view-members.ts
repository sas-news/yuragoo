// Member-facing helpers for the room view: the stable display-name
// fallback, the seated-member filter, and the players/host patch each
// membership event applies. Type-only imports keep this module a leaf.
import type { RoomPlayerView, ServerEnvelope } from "@yuragoo/protocol";
import type { RoomView } from "./room-view";

// Unnamed members never render their raw id (a ULID fragment reads as
// random noise) — fall back to a stable seat label. Same rule in the
// lobby roster, the dock, the HUD and the feed so one member is one name
// everywhere. `players` is joinOrder-sorted, so the index is stable.
export const memberName = (players: readonly RoomPlayerView[], id: string): string => {
  const at = players.findIndex((p) => p.playerId === id);
  if (at < 0) return "メンバー"; // a departed member's old feed lines
  const display = players[at]?.displayName?.trim();
  return display !== undefined && display !== "" ? display : `プレイヤー${at + 1}`;
};

// Members that take part in the lobby gate and the choice assignments:
// lobbyWaiting joiners sit in the roster but hold no seat row.
export const seatedMembers = (view: RoomView): readonly RoomPlayerView[] =>
  view.players.filter((p) => !p.lobbyWaiting);

// memberJoined/memberLeft/presenceChanged/hostChanged all fold into the
// same view patch — the joiner upserts (sorted by joinOrder), the leaver
// drops out, presence flips a flag, hostChanged moves the pointer.
export const membershipPatch = (
  view: RoomView,
  env: ServerEnvelope,
): Partial<Pick<RoomView, "players" | "hostPlayerId">> => {
  switch (env.type) {
    case "memberJoined":
      return {
        players: [
          ...view.players.filter((p) => p.playerId !== env.payload.playerId),
          env.payload,
        ].sort((a, b) => a.joinOrder - b.joinOrder),
      };
    case "memberLeft":
      return { players: view.players.filter((p) => p.playerId !== env.payload.playerId) };
    case "presenceChanged":
      return {
        players: view.players.map((p) =>
          p.playerId === env.payload.playerId ? { ...p, connected: env.payload.connected } : p,
        ),
      };
    case "hostChanged":
      return { hostPlayerId: env.payload.playerId };
    default:
      return {};
  }
};
