// Task 35 token exchange: POST /api/discord/token swaps the authorize()
// code for an OAuth access token the client hands to SDK authenticate().
// The raw token is passed straight back to the caller — it is their own
// credential — and is never logged, persisted or echoed in errors.
import type { Context } from "hono";
import type { ServerBindings } from "../config";
import { RoomError } from "../rooms/api";
import {
  discordFetch,
  discordJsonBody,
  discordStatusError,
  type DiscordApiDeps,
  resolveDiscordDeps,
} from "./discord-membership";
import { codeOf, fail, failOn, guardOrigin, readBody, stringField } from "./registry";

const CODE_FIELD_MAX = 128;

// grant_type=authorization_code at the upstream /oauth2/token endpoint.
// Missing client config is a deployment fault, not a client fault — it
// answers config/503 instead of ever sending an unauthenticated exchange.
export const exchangeDiscordCode = async (deps: DiscordApiDeps, code: string): Promise<string> => {
  if (deps.clientId === "" || deps.clientSecret === "") {
    throw new RoomError("config", "discord oauth is not configured");
  }
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
  });
  const res = await discordFetch(deps, "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw discordStatusError(res.status);
  const body = await discordJsonBody(res);
  const token = body.access_token;
  if (typeof token !== "string" || token === "") {
    throw new RoomError("discord-upstream", "token response has no access_token");
  }
  return token;
};

// The route body: { code } under the shared 16KiB cap; the OAuth response
// { access_token } passes through verbatim.
export const discordTokenRoute = (bindings: ServerBindings) => async (c: Context) => {
  const denied = guardOrigin(bindings)(c);
  if (denied !== null) return denied;
  const parsed = await readBody(c);
  if (!parsed.ok) return parsed.res;
  const code = stringField(parsed.body, "code", CODE_FIELD_MAX);
  if (code === null) return fail(c, "invalid-request", 422);
  try {
    const accessToken = await exchangeDiscordCode(resolveDiscordDeps(bindings), code);
    return c.json({ access_token: accessToken });
  } catch (e) {
    return failOn(c, codeOf(e));
  }
};
