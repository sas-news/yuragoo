// Platform bootstrap (Task 34): picks the running platform from an
// explicit signal — never from iframe detection alone. ?platform=discord
// (or the embedded-app-sdk injecting its frame_id query) selects the
// Discord adapter; everything else stays the browser adapter. The SDK
// is loaded lazily so the plain web build never downloads it.
import {
  BrowserAdapter,
  DiscordAdapter,
  classifyDiscordError,
  discordErrorCopy,
  establishDiscordSession,
  type ClassifiedError,
  type DiscordSdkLike,
  type DiscordSession,
  type PlatformAdapter,
} from "@yuragoo/platform";
import { apiOrigin, type JoinedSession } from "../lobby/room-session";

export type PlatformKind = "browser" | "discord";

// Detection: an explicit ?platform=discord param OR the Activity query
// params the Discord client injects (frame_id + instance_id). The param
// check alone decides — window.top comparisons proved flaky across
// Discord desktop embeds, so iframe-ness never decides by itself.
const discordParam = (): boolean => {
  const q = new URLSearchParams(window.location.search);
  return q.get("platform") === "discord" || q.has("frame_id");
};

export const platformKind = (): PlatformKind => (discordParam() ? "discord" : "browser");

export const platformAdapter = (): PlatformAdapter =>
  platformKind() === "discord" ? DiscordAdapter : BrowserAdapter;

// The injected SDK factory — tests/e2e swap in DiscordSDKMock; production
// lazy-imports the real package so browser bundles never fetch it.
export type SdkFactory = (clientId: string) => Promise<DiscordSdkLike>;

declare global {
  interface Window {
    __yuragooSdkFactory?: SdkFactory;
    __yuragooPlatform?: {
      bootPlatform: typeof bootPlatform;
      watchLayout: typeof import("@yuragoo/platform").watchLayout;
      DISCORD_EVENTS: typeof import("@yuragoo/platform").DISCORD_EVENTS;
    };
  }
}

const realSdkFactory: SdkFactory = async (clientId) => {
  const m = await import("@discord/embedded-app-sdk");
  return new m.DiscordSDK(clientId) as unknown as DiscordSdkLike;
};

export interface PlatformBoot {
  readonly kind: PlatformKind;
  readonly adapter: PlatformAdapter;
  readonly sdk: DiscordSdkLike | null;
  readonly session: DiscordSession | null;
}

export interface BootResult {
  readonly boot: PlatformBoot;
  readonly error: ClassifiedError | null;
}

// The shared post step for the server exchange — the endpoint lives on
// the worker (Task 35), not the SDK, so it goes through the same origin
// resolution as every other room call.
const exchangeToken =
  (origin: string) =>
  async (code: string): Promise<string> => {
    const res = await fetch(`${origin}/api/discord/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`discord-auth-${res.status}`);
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("discord-auth-empty");
    }
    return body.access_token;
  };

// Boot the platform once per page load. On discord the full auth chain
// runs here so every later screen can assume a verified session — a
// failure surfaces as a classified error the caller can render + retry.
export const bootPlatform = async (
  clientId: string,
  factory: SdkFactory = window.__yuragooSdkFactory ?? realSdkFactory,
): Promise<BootResult> => {
  const kind = platformKind();
  const adapter = platformAdapter();
  if (kind === "browser") {
    return { boot: { kind, adapter, sdk: null, session: null }, error: null };
  }
  if (clientId === "") {
    // No application id configured — the Activity can never authorize.
    return {
      boot: { kind, adapter, sdk: null, session: null },
      error: { kind: "unavailable", retryable: false },
    };
  }
  try {
    const sdk = await factory(clientId);
    const session = await establishDiscordSession({
      sdk,
      clientId,
      exchangeToken: exchangeToken(apiOrigin()),
    });
    return { boot: { kind, adapter, sdk, session }, error: null };
  } catch (error) {
    return {
      boot: { kind, adapter, sdk: null, session: null },
      error: classifyDiscordError(error),
    };
  }
};

// Soft Japanese copy for a classified failure — one place so retry UIs
// never hand-roll messages.
export const platformErrorText = (error: ClassifiedError): string => discordErrorCopy(error.kind);

// Re-exports so screens import one module.
export type { DiscordSession, JoinedSession };
