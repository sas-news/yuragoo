// Discord participant-drop presence path (Task 48): a room member inside
// the Activity instance reports ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE —
// any CONNECTED player whose verified discord_user_id is missing left the
// Activity while their zombie iframe kept the socket/lease alive. The
// report is authoritative: in the lobby the seat is vacated immediately
// (member row deleted, same as `leave`); mid-game it falls back to a
// plain disconnect so the roster survives a reconnect. The stale socket
// still closes — a false report self-heals via a fresh invite join.
import { findRoomPlayer, listRoomPlayers } from "./auth-storage";
import { Acc, NONE, type PresenceHost, type PresenceOutcome } from "./presence";
import { dropMember } from "./presence-vacate";

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
    dropMember(host, p.playerId, nowMs, acc);
  }
  return acc.done();
};
