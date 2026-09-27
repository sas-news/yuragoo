// RoomPlayerView assembly (Task 40 split from wire.ts for the LOC cap):
// the snapshot's players list and the memberJoined payload share this
// shape — one mapping keeps "who is seated" identical in both places.
import type { RoomPlayer } from "./auth-storage";

export const roomPlayerView = (p: RoomPlayer, nowMs: number) => ({
  playerId: p.playerId,
  joinOrder: p.joinOrder,
  displayName: p.displayName,
  lobbyWaiting: p.lobbyWaiting,
  connected: p.leaseUntilMs !== null && p.leaseUntilMs > nowMs,
  platform: p.platform,
});
