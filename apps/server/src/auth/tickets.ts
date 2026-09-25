// Single-use WebSocket tickets. A session mints a 30-second bearer ticket;
// the DO stores only its SHA-256 hash and consumes it atomically inside
// transactionSync — one row read + delete in the same commit means a ticket
// can never be spent twice, even by concurrent upgrades.
import { bumpSocketGeneration, findPlayerBySessionHash } from "../rooms/auth-storage";
import { RoomError } from "../rooms/api";
import { randomToken, sha256B64 } from "./invites";

export const TICKET_TTL_MS = 30_000;
export const TICKET_TTL_SEC = 30;

// The raw ticket leaves the DO exactly once (issueTicket's response); only
// its hash is ever persisted.
export const issueTicketSecret = async (): Promise<{ ticket: string; ticketHash: string }> => {
  const ticket = randomToken(32);
  return { ticket, ticketHash: await sha256B64(ticket) };
};

// Session-hash -> ticket row. Replaces any outstanding ticket for the
// player so the table stays bounded; runs inside the caller's transaction.
export const commitIssueTicket = (
  sql: SqlStorage,
  sessionHash: string,
  ticketHash: string,
  nowMs: number,
): void => {
  const player = findPlayerBySessionHash(sql, sessionHash);
  if (player === null) {
    throw new RoomError("bad-session", "session token is invalid");
  }
  sql.exec("DELETE FROM ws_tickets WHERE player_id = ?", player.playerId);
  sql.exec(
    "INSERT INTO ws_tickets (ticket_hash, player_id, expires_at_ms) VALUES (?, ?, ?)",
    ticketHash,
    player.playerId,
    nowMs + TICKET_TTL_MS,
  );
};

// Atomic consume: the row is always deleted (single-use), then expiry is
// enforced, then the player's socket generation advances for the upgrade.
export const commitConsumeTicket = (
  sql: SqlStorage,
  ticketHash: string,
  nowMs: number,
): { playerId: string; socketGeneration: number } => {
  const row = sql
    .exec<{ player_id: string; expires_at_ms: number }>(
      "SELECT player_id, expires_at_ms FROM ws_tickets WHERE ticket_hash = ?",
      ticketHash,
    )
    .toArray()[0];
  if (row === undefined) throw new RoomError("bad-ticket", "ticket is invalid");
  sql.exec("DELETE FROM ws_tickets WHERE ticket_hash = ?", ticketHash);
  if (row.expires_at_ms <= nowMs) {
    throw new RoomError("ticket-expired", "ticket expired");
  }
  return { playerId: row.player_id, socketGeneration: bumpSocketGeneration(sql, row.player_id) };
};
