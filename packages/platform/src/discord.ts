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
  // null inside (G)DM contexts — openInviteDialog throws INVALID_CHANNEL
  // there, so the fallback path checks it before calling.
  readonly guildId?: string | null;
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
    // CREATE_INSTANT_INVITE check before openInviteDialog; absent on older
    // clients so the property stays optional and a missing call skips the
    // permission gate rather than breaking the fallback.
    getChannelPermissions?(): Promise<{ permissions: string | bigint }>;
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
// instance. IMPORTANT: success:false means the user DISMISSED the share
// modal — it is a cancel, not an error, so it never falls back or raises
// a toast. A thrown shareLink (older client / unsupported) falls back to
// the native invite dialog, which itself needs a guild channel and
// CREATE_INSTANT_INVITE; both are gated before the call so a DM context
// or permission-less member skips straight to a typed failure the UI can
// translate into a concrete Japanese message. Both live behind the
// adapter — the game UI never touches SDK commands directly.
export type ShareInviteResult =
  | "shared"
  | "cancelled"
  | { readonly reason: "dm" | "no-invite-permission" | "error"; readonly detail: string };

// CREATE_INSTANT_INVITE bit (0x1) in the channel permissions bitfield.
const CREATE_INSTANT_INVITE = 0x1n;

// This package's tsconfig has no DOM lib — reach console structurally.
const warn = (message: string, error?: unknown): void =>
  (globalThis as { console?: { warn?: (m: string, e?: unknown) => void } }).console?.warn?.(
    message,
    error,
  );

// Short, non-sensitive diagnostics for the UI message — Discord RPC
// errors carry {code, message}; either alone is safe to surface.
const detailOf = (error: unknown): string => {
  const e = error as { code?: unknown; message?: unknown };
  const parts = [e?.code, e?.message]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .map((p) => p.slice(0, 60));
  return parts.join(": ");
};

// sendCommand has no timeout — a command Discord ignores (never acked,
// modal invisible, bridge not ready) leaves the promise pending forever.
// Every call here gets a deadline so the status line always resolves.
const withTimeout = <T>(work: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout?.(
        () => reject(new Error(`timeout:${label}`)),
        ms,
      ),
    ),
  ]);

const READY_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

type DialogGate = "ok" | "dm" | "no-invite-permission";

const canOpenInviteDialog = async (sdk: DiscordSdkLike): Promise<DialogGate> => {
  if (sdk.guildId === null) return "dm";
  try {
    const res = await sdk.commands.getChannelPermissions?.();
    if (res === undefined) return "ok"; // older client: try the dialog anyway
    return (BigInt(res.permissions) & CREATE_INSTANT_INVITE) !== 0n ? "ok" : "no-invite-permission";
  } catch {
    return "ok"; // a permission probe failure shouldn't block the dialog
  }
};

export const shareInvite = async (
  sdk: DiscordSdkLike,
  message: string,
  customId?: string,
): Promise<ShareInviteResult> => {
  // The room page's SDK ran the constructor's handshake but nobody ever
  // awaited READY — commands sent before it can hang silently.
  try {
    await withTimeout(sdk.ready(), READY_TIMEOUT_MS, "sdk-ready");
  } catch (err) {
    return { reason: "error", detail: detailOf(err) };
  }
  let shareError = "";
  try {
    const res = await withTimeout(
      sdk.commands.shareLink({ message, custom_id: customId }),
      COMMAND_TIMEOUT_MS,
      "share-link",
    );
    if (res !== null && res !== undefined) {
      // success:false = the modal was dismissed; do not double-prompt.
      return res.success === false ? "cancelled" : "shared";
    }
  } catch (err) {
    // fall through to the invite dialog — but keep the RPC error visible
    // for real-client debugging (Discord errors carry {code,message}).
    warn("[yuragoo] shareLink threw, trying invite dialog", err);
    shareError = detailOf(err);
  }
  const gate = await canOpenInviteDialog(sdk);
  if (gate !== "ok") {
    warn(`[yuragoo] invite dialog unavailable (${gate})`);
    return { reason: gate, detail: shareError };
  }
  try {
    await withTimeout(sdk.commands.openInviteDialog(), COMMAND_TIMEOUT_MS, "invite-dialog");
    return "shared";
  } catch (err) {
    warn("[yuragoo] openInviteDialog failed", err);
    return { reason: "error", detail: detailOf(err) || shareError };
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
