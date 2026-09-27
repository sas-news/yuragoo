// Room-auth RPC bodies (Task 18) factored out of GameRoom.ts so the class
// file stays under the handwritten-size cap. Each function runs the same
// sequence the old inline methods did: async credential work first, then
// verify+write inside one transactionSync. The room's open-books/closed
// guard stays in the GameRoom delegate methods.
import {
  commitConsumeTicket,
  commitIssueTicket,
  issueTicketSecret,
  TICKET_TTL_SEC,
} from "../auth/tickets";
import { commitJoin, commitReconnect, issueCredentials, rotateTokens } from "../auth/sessions";
import type {
  ConsumeTicketInput,
  ConsumeTicketResult,
  IssueTicketInput,
  IssueTicketResult,
  JoinRoomInput,
  JoinRoomResult,
  ReconnectInput,
  ReconnectResult,
} from "./api";
import type { CommandHost } from "./commands";
import { onMemberJoined } from "./lobby";
import { maxEventSeq } from "./storage";
import { broadcastNewEvents } from "./wire";

export const join = async (room: CommandHost, input: JoinRoomInput): Promise<JoinRoomResult> => {
  const creds = await issueCredentials();
  const books = room.booksView();
  const lobbyWaiting = books !== null && books.state.phase !== "lobby";
  return room.txn(() => {
    const joined = commitJoin(room.sql, { ...input, lobbyWaiting }, creds);
    // Task 24/35: the memberJoined ledger row + lobby choice growth commit
    // inside the same transaction — a Discord rejoin reclaims its seat, so
    // only a genuinely new member writes the row. joinRoomAt broadcasts.
    if (joined.isNew) {
      onMemberJoined(
        room.sql,
        {
          playerId: joined.playerId,
          joinOrder: joined.joinOrder,
          displayName: joined.displayName,
          lobbyWaiting,
          platform: input.platform,
        },
        books !== null,
      );
    }
    return joined;
  });
};

// Verify + rotate in one transaction: the old reconnect token dies the
// moment the new hashes land.
export const reconnect = async (
  room: CommandHost,
  input: ReconnectInput,
): Promise<ReconnectResult> => {
  const tokens = await rotateTokens();
  return room.txn(() => commitReconnect(room.sql, input.reconnectTokenHash, tokens));
};

export const issueTicket = async (
  room: CommandHost,
  input: IssueTicketInput,
): Promise<IssueTicketResult> => {
  const issued = await issueTicketSecret();
  room.txn(() =>
    commitIssueTicket(room.sql, input.sessionTokenHash, issued.ticketHash, input.nowMs),
  );
  return { ticket: issued.ticket, expiresInSec: TICKET_TTL_SEC };
};

export const consumeTicket = (room: CommandHost, input: ConsumeTicketInput): ConsumeTicketResult =>
  room.txn(() => commitConsumeTicket(room.sql, input.ticketHash, input.nowMs));

// --- RPC entrypoint wrappers ---------------------------------------------
// Every player-facing room-auth RPC runs the same prelude before the async
// body: the live guard (open storage + inside the empty-grace window) and
// a lease sweep so dead rows are gone before credentials get written.

export interface AuthRpcHost extends CommandHost {
  assertLive(): void;
  sweepLeases(): void;
  // Task 24: join now persists broadcast rows (memberJoined/lobbyChanged)
  // — the RPC path replays them to live sockets after the commit.
  sockets(): readonly WebSocket[];
}

export const joinRoomAt = async (
  room: AuthRpcHost,
  input: JoinRoomInput,
): Promise<JoinRoomResult> => {
  room.assertLive();
  room.sweepLeases();
  const since = maxEventSeq(room.sql);
  const joined = await join(room, input);
  broadcastNewEvents(room, since, room.booksView()?.state ?? null);
  return joined;
};

export const reconnectAt = (room: AuthRpcHost, input: ReconnectInput): Promise<ReconnectResult> => {
  room.assertLive();
  room.sweepLeases();
  return reconnect(room, input);
};

export const issueTicketAt = (
  room: AuthRpcHost,
  input: IssueTicketInput,
): Promise<IssueTicketResult> => {
  room.assertLive();
  room.sweepLeases();
  return issueTicket(room, input);
};

export const consumeTicketAt = (
  room: AuthRpcHost,
  input: ConsumeTicketInput,
): ConsumeTicketResult => {
  room.assertLive();
  room.sweepLeases();
  return consumeTicket(room, input);
};
