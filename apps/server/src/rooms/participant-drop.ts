// Discord participant-drop presence path (Task 48): a room member inside
// the Activity instance reports ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE —
// any CONNECTED player whose verified discord_user_id is missing left the
// Activity while their zombie iframe kept the socket/lease alive. The drop
// reuses markDisconnected (host election + empty-room clock included) and
// closes the stale socket, so a false report self-heals via the client's
// normal reconnect instead of sticking a live player as disconnected.
import { findRoomPlayer, listRoomPlayers } from "./auth-storage";
import { Acc, markDisconnected, NONE, type PresenceHost, type PresenceOutcome } from "./presence";

export const dropMissingParticipants = (
  host: PresenceHost,
  reporterId: string,
  userIds: readonly string[],
  nowMs: number,
): PresenceOutcome => {
  const reporterDiscord = findRoomPlayer(host.sql, reporterId)?.discordUserId ?? null;
  // Only a verified Discord member may report, and only from inside the
  // instance — a report missing the reporter's own id is meaningless.
  if (reporterDiscord === null || !userIds.includes(reporterDiscord)) return NONE;
  const present = new Set(userIds);
  const acc = new Acc();
  for (const p of listRoomPlayers(host.sql)) {
    // Browser members carry no discord id — never dropped by this path.
    if (p.discordUserId === null || present.has(p.discordUserId)) continue;
    if (p.leaseUntilMs === null || p.leaseUntilMs <= nowMs) continue; // already out
    acc.expiredIds.push(p.playerId);
    markDisconnected(host, p.playerId, nowMs, acc);
  }
  return acc.done();
};
