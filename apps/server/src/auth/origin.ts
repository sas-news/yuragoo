// Origin allowlist for the room-auth routes (join / reconnect / ticket /
// ws-upgrade). Auth here is explicit secrets in request bodies — there are
// no ambient credentials like cookies — so a missing Origin (non-browser
// client) is allowed, while a present Origin must match the env allowlist.
// In local mode every loopback origin (any port) is allowed on top.
import { parseServerMode, type ServerBindings } from "../config";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const allowedFromEnv = (raw: string | undefined): readonly string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
};

// A ".suffix" entry (e.g. ".discordsays.com") matches any https subdomain:
// Discord Activities always arrive through a <app-id>.discordsays.com
// proxy origin, so the allowlist accepts the pattern rather than every id.
const discordOriginAllowed = (origin: string, bindings: ServerBindings): boolean => {
  const entries = allowedFromEnv(bindings.DISCORD_ORIGINS);
  if (entries.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    return entries.some((e) => e.startsWith(".") && url.hostname.endsWith(e));
  } catch {
    return false;
  }
};

export const originAllowed = (originHeader: string | null, bindings: ServerBindings): boolean => {
  if (originHeader === null || originHeader === "") return true;
  if (allowedFromEnv(bindings.ALLOWED_ORIGINS).includes(originHeader)) return true;
  if (discordOriginAllowed(originHeader, bindings)) return true;
  return parseServerMode(bindings.APP_ENV) === "local" && isLoopbackOrigin(originHeader);
};
