// Platform adapter seam: every supported platform (browser today, Discord
// Activity later) shapes the same room-auth requests through one interface.
// The adapter only owns request/response shaping — transports stay outside
// so these types work from the web client, the server and tests alike.
export type PlatformKind = "browser" | "discord";

// POST /api/rooms -> the one response that ever carries a raw invite
// secret. inviteUrl must keep the secret inside the fragment only.
export interface CreateRoomResponse {
  readonly roomId: string;
  readonly inviteSecret: string;
  readonly inviteUrl: string;
}

export interface JoinRequest {
  readonly inviteSecret: string;
  readonly displayName?: string;
}

export interface JoinResponse {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
  readonly lobbyWaiting: boolean;
}

export interface ReconnectRequest {
  readonly reconnectToken: string;
}

// Reconnect rotates both tokens; the playerId is echoed back so the client
// can confirm which seat it recovered.
export interface ReconnectResponse {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
}

export interface TicketRequest {
  readonly sessionToken: string;
}

export interface TicketResponse {
  readonly ticket: string;
  readonly expiresInSec: number;
}

// One session recovered through reconnect: everything the client needs to
// keep in sessionStorage (never localStorage, never cookies).
export interface RoomSession {
  readonly roomId: string;
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly createPath: string;
  joinPath(roomId: string): string;
  reconnectPath(roomId: string): string;
  ticketPath(roomId: string): string;
  wsPath(roomId: string, ticket: string): string;
  joinBody(inviteSecret: string, displayName?: string): JoinRequest;
  reconnectBody(reconnectToken: string): ReconnectRequest;
  ticketBody(sessionToken: string): TicketRequest;
}
