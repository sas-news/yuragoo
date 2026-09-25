// WS upgrade admission (Task 19) + presence resume (Task 20). GameRoom.fetch
// consumes the single-use ticket, then hands the verified identity here:
// the pair is accepted with its {playerId, socketGeneration} attachment
// (the ONLY source of client identity — payloads can never claim it), the
// player's older sockets are replaced, and one presence transaction grants
// the lease, clears the empty-room bookkeeping (parked deadlines shift by
// the paused duration), emits presenceChanged/hostChanged ledger rows and
// re-elects the host when the named host is away. The new socket's first
// frame is a full snapshot sent BEFORE the event broadcast, so it heals
// past the just-committed presence seqs instead of resyncing.
import { sha256B64 } from "../auth/invites";
import { RoomError, type ConsumeTicketInput, type ConsumeTicketResult } from "./api";
import { admit as admitPresence, commitPresence } from "./presence";
import { displayHostId } from "./host-election";
import { readLobby } from "./lobby";
import { attachmentOf, sendTo, snapshotFrame, type SocketAttachment } from "./wire";
import type { SocketHost } from "./transport";

// The GameRoom.fetch surface: SocketHost + the ticket-consuming RPC.
export interface UpgradeHost extends SocketHost {
  consumeTicket(input: ConsumeTicketInput): ConsumeTicketResult;
}

// WS upgrade endpoint: single-use ticket -> 101 pair (or an HTTP error).
// A dead room answers 410 so clients stop retrying instead of racing it.
export const upgradeFetch = async (host: UpgradeHost, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/ws")) return new Response("not-found", { status: 404 });
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("upgrade-required", { status: 426 });
  }
  const ticket = url.searchParams.get("ticket");
  if (ticket === null || ticket === "") return new Response("bad-ticket", { status: 401 });
  const ticketHash = await sha256B64(ticket);
  try {
    return admitUpgrade(host, host.consumeTicket({ ticketHash, nowMs: Date.now() }));
  } catch (error) {
    if (
      error instanceof RoomError &&
      (error.code === "room-expired" || error.code === "room-closed")
    ) {
      return new Response("room-gone", { status: 410 });
    }
    return new Response("unauthorized", { status: 401 });
  }
};

export const admitUpgrade = (host: SocketHost, auth: SocketAttachment): Response => {
  const pair = new WebSocketPair();
  const server = pair[1];
  host.acceptSocket(server, auth);
  for (const ws of host.sockets()) {
    if (ws === server) continue;
    const old = attachmentOf(ws);
    if (
      old !== null &&
      old.playerId === auth.playerId &&
      old.socketGeneration < auth.socketGeneration
    ) {
      try {
        ws.close(1000, "replaced");
      } catch {
        // Already closing.
      }
    }
  }
  try {
    commitPresence(
      host,
      (h) => admitPresence(h, auth.playerId, Date.now()),
      () => {
        sendTo(
          server,
          snapshotFrame(
            host,
            host.booksView(),
            host.listPlayers(),
            displayHostId(host.sql),
            readLobby(host.sql),
          ),
        );
      },
    );
  } catch (error) {
    try {
      server.close(1011, "admission-failed");
    } catch {
      // Never accepted upstream.
    }
    throw error;
  }
  return new Response(null, { status: 101, webSocket: pair[0] });
};
