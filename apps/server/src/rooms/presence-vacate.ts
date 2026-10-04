// Departed-member seat release: a disconnect arms a vacate:<playerId>
// deadline (see markDisconnected) at now + VACATE_GRACE_MS. Fired while
// the lobby is open it deletes the member row outright — memberLeft
// broadcasts, the ready flag drops, the seat draft orphans — so a real
// departure stops blocking the start gate once the grace has passed.
// Re-admission deletes the row; a game in flight re-arms it because
// roster integrity beats seat release until the lobby comes back.
import { deleteRoomPlayer, findRoomPlayer } from "./auth-storage";
import { type Deadline, replaceDeadline } from "./deadlines";
import { VACATE_GRACE_MS, VACATE_TAG, vacateDeadlineId } from "./leases";
import { onMemberLeft } from "./lobby";
import { type Acc, departed, type PresenceHost } from "./presence";

// The member row dies with its tokens exactly like `leave` — the seat
// becomes an orphan draft and a fresh invite join is the only way back.
export const vacateMember = (
  host: PresenceHost,
  playerId: string,
  nowMs: number,
  acc: Acc,
): void => {
  deleteRoomPlayer(host.sql, playerId);
  onMemberLeft(host.sql, playerId, host.booksView() !== null);
  departed(host, nowMs, acc);
};

// Alarm dispatch: a due vacate:<pid> row removes the member when the
// lobby is still open and the player stayed disconnected.
export const fireVacateDeadlines = (
  host: PresenceHost,
  rows: readonly Deadline[],
  nowMs: number,
  acc: Acc,
): void => {
  for (const row of rows) {
    const playerId = row.id.slice(vacateDeadlineId("").length);
    const player = findRoomPlayer(host.sql, playerId);
    if (player === null) continue; // already gone — row consumed
    if (player.leaseUntilMs !== null && player.leaseUntilMs > nowMs) continue; // re-admitted
    if (host.booksView() === null) {
      acc.expiredIds.push(playerId);
      vacateMember(host, playerId, nowMs, acc);
    } else {
      replaceDeadline(host.sql, row.id, nowMs + VACATE_GRACE_MS, VACATE_TAG);
    }
  }
};
