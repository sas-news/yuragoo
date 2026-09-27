// Discord Activity platform (Task 34): the narrow SDK surface the game
// needs, expressed as an injected interface — this package never imports
// @discord/embedded-app-sdk so the browser bundle and game-core stay
// free of it. bootstrap.ts (apps/web) wires the real SDK in; tests wire
// the shipped DiscordSDKMock or a hand-rolled fake.
import type { PlatformAdapter } from "./adapter";

// What the adapter hands back after the auth sequence completes. The
// access token authenticates the SDK session; instanceId binds the room.
export interface DiscordSession {
  readonly accessToken: string;
  readonly instanceId: string;
  readonly channelId: string | null;
}

// Subscribe handles return a cleanup so a stale layout/participant event
// can never reach a torn-down game screen.
export interface DiscordSubscription {
  off(): void;
}

// The commands the adapter calls — a subset of DiscordSDK. Structural,
// so both the real SDK and the mock satisfy it without casts.
export interface DiscordSdkLike {
  readonly instanceId: string;
  readonly channelId?: string | null;
  ready(): Promise<void>;
  commands: {
    authorize(input: {
      client_id: string;
      response_type: "code";
      scope: readonly string[];
      prompt?: "none" | "consent" | null;
      state?: string;
    }): Promise<{ code: string } | null>;
    authenticate(input: { access_token: string }): Promise<unknown>;
    shareLink(input: {
      message: string;
      custom_id?: string | undefined;
    }): Promise<{ success?: boolean } | null>;
    openInviteDialog(): Promise<unknown>;
  };
  subscribe(event: string, listener: (data: unknown) => unknown): Promise<unknown> | unknown;
  unsubscribe(event: string, listener: (data: unknown) => unknown): Promise<unknown> | unknown;
  close?(code: number, message: string): void;
}

// The server exchange endpoint (Task 35 contract): code -> access token.
export type TokenExchange = (code: string) => Promise<string>;

export interface DiscordAdapterDeps {
  readonly sdk: DiscordSdkLike;
  readonly clientId: string;
  readonly exchangeToken: TokenExchange;
}

// The login sequence as ONE ordered driver: ready -> authorize(identify
// only, prompt suppressed after first consent) -> server code exchange ->
// authenticate. Steps never overlap — an SDK that resolves authorize
// before ready would hand a code the server cannot tie to a session.
export const establishDiscordSession = async (
  deps: DiscordAdapterDeps,
): Promise<DiscordSession> => {
  await deps.sdk.ready();
  const auth = await deps.sdk.commands.authorize({
    client_id: deps.clientId,
    response_type: "code",
    scope: ["identify"],
    prompt: "none",
  });
  const code = auth?.code;
  if (typeof code !== "string" || code === "") {
    throw new Error("discord-auth-denied");
  }
  const accessToken = await deps.exchangeToken(code);
  await deps.sdk.commands.authenticate({ access_token: accessToken });
  return {
    accessToken,
    instanceId: deps.sdk.instanceId,
    channelId: deps.sdk.channelId ?? null,
  };
};

// shareLink is the sanctioned invite inside an Activity: it posts into
// the channel with the custom_id so Discord routes joiners at the same
// instance. Falls back to the native invite dialog when shareLink throws,
// reports failure, or is unavailable (older client) — the dialog is the
// last resort before surfacing an error. Both live behind the adapter —
// the game UI never touches SDK commands directly.
export const shareInvite = async (
  sdk: DiscordSdkLike,
  message: string,
  customId?: string,
): Promise<boolean> => {
  try {
    const res = await sdk.commands.shareLink({ message, custom_id: customId });
    if (res !== null && res !== undefined && res.success !== false) return true;
  } catch {
    // fall through to the invite dialog
  }
  try {
    await sdk.commands.openInviteDialog();
    return true;
  } catch {
    return false;
  }
};

// The adapter platform half: join still posts to the room API, but the
// invite-secret slot carries the verified access token — the server-side
// route decides membership. inviteUrl is meaningless inside an Activity;
// shareInvite replaces link copying.
export const DiscordAdapter: PlatformAdapter = {
  kind: "discord",
  createPath: "/api/rooms/discord",
  joinPath: () => "/api/rooms/discord/join",
  reconnectPath: (roomId) => `/api/rooms/${roomId}/reconnect`,
  ticketPath: (roomId) => `/api/rooms/${roomId}/ticket`,
  wsPath: (roomId, ticket) => `/api/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`,
  joinBody: (inviteSecret, displayName) =>
    displayName === undefined ? { inviteSecret } : { inviteSecret, displayName },
  reconnectBody: (reconnectToken) => ({ reconnectToken }),
  ticketBody: (sessionToken) => ({ sessionToken }),
};
