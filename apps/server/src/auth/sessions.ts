// Credential lifecycle + auth transaction bodies for the GameRoom Durable
// Object. Token generation and hashing are async and run BEFORE the
// transaction (crypto.subtle cannot be awaited inside transactionSync);
// the commit* functions are synchronous SQLite steps the DO runs inside
// ctx.storage.transactionSync so verify+write commit or roll back as one.
import {
  findPlayerByDiscordId,
  findPlayerByReconnectHash,
  insertRoomPlayer,
  readRoomAuth,
  roomPlayerCount,
  updateDiscordSeat,
  updateSessionHashes,
  writeRoomAuth,
} from "../rooms/auth-storage";
import { RoomError } from "../rooms/api";
import { randomToken, sha256B64 } from "./invites";

export const MAX_ROOM_PLAYERS = 6;
// 128-bit ids -> 22 base64url chars, inside the game-core playerId alphabet.
const PLAYER_ID_BYTES = 16;
const TOKEN_BYTES = 32;

export interface IssuedCredentials {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
  readonly sessionHash: string;
  readonly reconnectHash: string;
}

export type RotatedTokens = Omit<IssuedCredentials, "playerId">;

// A fresh seat: server-side playerId plus the raw tokens, which leave the
// DO exactly once inside the join response.
export const issueCredentials = async (): Promise<IssuedCredentials> => {
  const sessionToken = randomToken(TOKEN_BYTES);
  const reconnectToken = randomToken(TOKEN_BYTES);
  const [sessionHash, reconnectHash] = await Promise.all([
    sha256B64(sessionToken),
    sha256B64(reconnectToken),
  ]);
  return {
    playerId: randomToken(PLAYER_ID_BYTES),
    sessionToken,
    reconnectToken,
    sessionHash,
    reconnectHash,
  };
};

// Rotation set for reconnect: overwriting the hashes kills the old tokens.
export const rotateTokens = async (): Promise<RotatedTokens> => {
  const c = await issueCredentials();
  return {
    sessionToken: c.sessionToken,
    reconnectToken: c.reconnectToken,
    sessionHash: c.sessionHash,
    reconnectHash: c.reconnectHash,
  };
};

export const commitInitRoom = (
  sql: SqlStorage,
  input: { readonly inviteSecretHash: string; readonly platform: string; readonly nowMs: number },
): void => {
  if (readRoomAuth(sql) !== null) {
    throw new RoomError("already-created", "room auth is already initialized");
  }
  writeRoomAuth(sql, input.inviteSecretHash, input.platform, input.nowMs);
};

export interface JoinCommit {
  readonly inviteSecretHash?: string;
  // Task 35: the Discord seat key — the OAuth-verified user id, set only
  // by the platform:"discord" route after /users/@me succeeds.
  readonly discordUserId?: string;
  // Discord CDN avatar URL from the verified profile (browser joins: null).
  readonly avatarUrl?: string | null;
  readonly displayName: string | null;
  readonly platform: string;
  readonly lobbyWaiting: boolean;
  readonly nowMs: number;
}

export interface Joined {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
  readonly joinOrder: number;
  readonly lobbyWaiting: boolean;
  readonly displayName: string | null;
  // False when a Discord rejoin reclaimed an existing seat — the caller
  // must not emit another memberJoined ledger row for it.
  readonly isNew: boolean;
}

export const commitJoin = (
  sql: SqlStorage,
  input: JoinCommit,
  creds: IssuedCredentials,
): Joined => {
  let auth = readRoomAuth(sql);
  if (auth === null) {
    // Task 35: a Discord join creates its instance-bound room lazily —
    // the stored invite hash is a random value nobody ever receives, so
    // the browser invite path can never mint a seat inside it. Browser
    // joins keep requiring a room that initRoom already initialized.
    if (input.platform !== "discord" || input.inviteSecretHash === undefined) {
      throw new RoomError("unknown-room", "room does not exist");
    }
    writeRoomAuth(sql, input.inviteSecretHash, input.platform, input.nowMs);
    auth = {
      inviteHash: input.inviteSecretHash,
      platform: input.platform,
      createdAtMs: input.nowMs,
    };
  }
  // The platform gate precedes the credential check so a browser join
  // aimed at a discord room is refused as platform-mismatch even without
  // a valid secret (discord rooms carry a random, never-shared hash).
  if (auth.platform !== input.platform) {
    throw new RoomError("platform-mismatch", "room belongs to a different platform");
  }
  if (input.platform === "discord") {
    // The verified user id IS the credential — a rejoin rotates the seat's
    // token hashes in place (the old session dies, a second socket replaces
    // the first) and refreshes the stored name; membership is untouched.
    if (input.discordUserId === undefined) {
      throw new RoomError("bad-invite", "discord joins require a verified user id");
    }
    const seat = findPlayerByDiscordId(sql, input.discordUserId);
    if (seat !== null) {
      updateDiscordSeat(
        sql,
        seat.playerId,
        creds.sessionHash,
        creds.reconnectHash,
        input.displayName,
        input.avatarUrl ?? null,
      );
      return {
        playerId: seat.playerId,
        sessionToken: creds.sessionToken,
        reconnectToken: creds.reconnectToken,
        joinOrder: seat.joinOrder,
        lobbyWaiting: seat.lobbyWaiting,
        displayName: input.displayName,
        isNew: false,
      };
    }
  } else if (auth.inviteHash !== input.inviteSecretHash) {
    throw new RoomError("bad-invite", "invite secret does not match");
  }
  const count = roomPlayerCount(sql);
  if (count >= MAX_ROOM_PLAYERS) {
    throw new RoomError("room-full", "room already has six players");
  }
  // Task 24: joinOrder must stay unique after `leave` punches a hole in
  // the count — max+1 keeps the seat ordering monotonic forever.
  const joinOrder =
    (sql.exec<{ m: number | null }>("SELECT MAX(join_order) AS m FROM room_players").one().m ??
      -1) + 1;
  insertRoomPlayer(sql, {
    playerId: creds.playerId,
    joinOrder,
    displayName: input.displayName,
    platform: input.platform,
    discordUserId: input.discordUserId ?? null,
    avatarUrl: input.avatarUrl ?? null,
    sessionHash: creds.sessionHash,
    reconnectHash: creds.reconnectHash,
    lobbyWaiting: input.lobbyWaiting,
    socketGeneration: 0,
    leaseUntilMs: null,
    joinedAtMs: input.nowMs,
  });
  return {
    playerId: creds.playerId,
    sessionToken: creds.sessionToken,
    reconnectToken: creds.reconnectToken,
    joinOrder,
    lobbyWaiting: input.lobbyWaiting,
    displayName: input.displayName,
    isNew: true,
  };
};

// Verify + rotate in one transaction: the old reconnect token dies the
// moment the new hashes land.
export const commitReconnect = (
  sql: SqlStorage,
  reconnectHash: string,
  tokens: RotatedTokens,
): { playerId: string; sessionToken: string; reconnectToken: string } => {
  const row = findPlayerByReconnectHash(sql, reconnectHash);
  if (row === null) throw new RoomError("bad-reconnect", "reconnect token is invalid");
  updateSessionHashes(sql, row.playerId, tokens.sessionHash, tokens.reconnectHash);
  return {
    playerId: row.playerId,
    sessionToken: tokens.sessionToken,
    reconnectToken: tokens.reconnectToken,
  };
};
