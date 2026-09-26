// Discord API access for Task 35: the upstream base URL and fetch are
// injectable so workers-pool tests stub the whole API. Verification
// never trusts a client-declared username — the display name is derived
// from the GET /users/@me payload alone, and secrets never reach logs.
import { playerNameSchema } from "@yuragoo/protocol";
import type { ServerBindings } from "../config";
import { RoomError } from "../rooms/api";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_TIMEOUT_MS = 10_000;
export const DISCORD_ID_MAX = 32;

// The upstream call signature, matching the decision-jobs UpstreamFetch
// convention (a string URL + init). Tests hand in fixture functions.
export type DiscordFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordApiDeps {
  readonly fetch: DiscordFetch;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly clientId: string;
  readonly clientSecret: string;
}

// Test/dev seam — resolved per request; injected fields override bindings.
let injected: Partial<DiscordApiDeps> | null = null;
export const injectDiscordApiDeps = (deps: Partial<DiscordApiDeps> | null): void => {
  injected = deps;
};

export const resolveDiscordDeps = (env: ServerBindings): DiscordApiDeps => {
  const envUrl = env.DISCORD_UPSTREAM_URL?.trim() ?? "";
  return {
    fetch: injected?.fetch ?? ((input, init) => fetch(input, init)),
    baseUrl: injected?.baseUrl ?? (envUrl === "" ? DISCORD_API_BASE : envUrl),
    timeoutMs: injected?.timeoutMs ?? DISCORD_TIMEOUT_MS,
    clientId: injected?.clientId ?? env.DISCORD_CLIENT_ID?.trim() ?? "",
    clientSecret: injected?.clientSecret ?? env.DISCORD_CLIENT_SECRET?.trim() ?? "",
  };
};

// Statuses map once for both upstream calls: 429 -> rate-limit, every
// other 4xx -> auth (rejected credential: bad code / expired token), and
// 5xx + malformed payloads -> upstream. Response bodies are never logged.
export const discordStatusError = (status: number): RoomError =>
  status === 429
    ? new RoomError("discord-rate-limit", "discord is rate-limiting requests")
    : status >= 400 && status < 500
      ? new RoomError("discord-auth", "discord rejected the credential")
      : new RoomError("discord-upstream", "discord responded with a server error");

export const discordFetch = (
  deps: DiscordApiDeps,
  path: string,
  init: RequestInit,
): Promise<Response> =>
  deps
    .fetch(`${deps.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    .catch(() => {
      throw new RoomError("discord-upstream", "discord request failed or timed out");
    });

export const discordJsonBody = async (res: Response): Promise<Record<string, unknown>> => {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RoomError("discord-upstream", "discord returned malformed JSON");
  }
  return body as Record<string, unknown>;
};

export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
}

// GET /users/@me is reachable with the identify scope alone, which is the
// only scope the Activity authorize step requests.
export const fetchDiscordUser = async (
  deps: DiscordApiDeps,
  accessToken: string,
): Promise<DiscordUser> => {
  const res = await discordFetch(deps, "/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw discordStatusError(res.status);
  const body = await discordJsonBody(res);
  const id = body.id;
  const username = body.username;
  const globalName = body.global_name;
  if (
    typeof id !== "string" ||
    id === "" ||
    id.length > DISCORD_ID_MAX ||
    typeof username !== "string" ||
    username === "" ||
    (globalName !== null && globalName !== undefined && typeof globalName !== "string")
  ) {
    throw new RoomError("discord-upstream", "discord user payload is incomplete");
  }
  return { id, username, globalName: typeof globalName === "string" ? globalName : null };
};

// global_name is the display name; username is the fallback. The value is
// clamped to the shared player-name contract (trimmed, 24 chars max) so a
// hostile or oversized profile can never poison snapshots.
export const discordDisplayName = (user: DiscordUser): string => {
  let name = user.globalName ?? user.username;
  while (!playerNameSchema.safeParse(name).success) {
    const trimmed = name.trim();
    if (trimmed.length <= 1) return "player";
    name = trimmed.slice(0, trimmed.length - 1);
  }
  return playerNameSchema.parse(name);
};
