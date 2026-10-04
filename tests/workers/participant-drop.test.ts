// Task 48 activity-leave detection: a Discord member's reportParticipants
// command marks verified members missing from the instance's participant
// list as disconnected — the zombie-iframe case where the socket and the
// heartbeat lease stay alive after the user leaves the Activity. A report
// that omits the reporter's own id is refused; rejoiners reconnect through
// the normal socket flow.
import { SELF } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  type DiscordFetch,
  injectDiscordApiDeps,
} from "../../apps/server/src/auth/discord-membership";
import { GOOD_ORIGIN, Sock } from "./ws-helpers";

const BASE = "https://ws.test";

interface FxUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

// Same stubbed Discord API shape as discord-auth.test.ts — tokens map to
// users 1:1, /users/@me is the identity oracle.
const fixture = () => {
  const users = new Map<string, FxUser>();
  let n = 0;
  const issue = (user: FxUser): string => {
    n += 1;
    const token = `tok-${n}`;
    users.set(token, user);
    return token;
  };
  const api: DiscordFetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/users/@me")) {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      const user = users.get(bearer.slice("Bearer ".length));
      return user === undefined
        ? Response.json({ message: "401" }, { status: 401 })
        : Response.json(user);
    }
    return new Response("not-found", { status: 404 });
  };
  return { api, issue };
};

const post = (path: string, body: unknown): Promise<Response> =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: JSON.stringify(body),
  });

const join = async (instanceId: string, token: string) => {
  const res = await post("/api/rooms/discord/join", { instanceId, accessToken: token });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    roomId: string;
    playerId: string;
    sessionToken: string;
  };
};

afterEach(() => injectDiscordApiDeps(null));

const ALICE: FxUser = { id: "111", username: "alice_u", global_name: "Alice", avatar: null };
const BOB: FxUser = { id: "222", username: "bob_u", global_name: null, avatar: null };

test("reportParticipants drops a member missing from the instance list", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const instanceId = `inst-${crypto.randomUUID()}`;
  const alice = await join(instanceId, fx.issue(ALICE));
  const bob = await join(instanceId, fx.issue(BOB));
  const sAlice = await Sock.connect(alice.roomId, alice.sessionToken);
  const sBob = await Sock.connect(bob.roomId, bob.sessionToken);

  // Alice reports the instance list — Bob (discord 222) is gone.
  sAlice.sendCmd(alice.roomId, "rp1", "reportParticipants", { userIds: [ALICE.id] });
  await sAlice.next((e) => e.type === "ack" && e.payload.commandId === "rp1");
  const drop = await sAlice.next(
    (e) => e.type === "presenceChanged" && e.payload.playerId === bob.playerId,
  );
  expect(drop.type).toBe("presenceChanged");
  if (drop.type === "presenceChanged") expect(drop.payload.connected).toBe(false);
  // The stale socket closes — a false drop self-heals via reconnect.
  const closed = await sBob.waitClose();
  expect(closed.reason).toBe("lease-expired");
  sAlice.close();
});

test("a report missing the reporter's own id is refused as a no-op", async () => {
  const fx = fixture();
  injectDiscordApiDeps({ fetch: fx.api });
  const instanceId = `inst-${crypto.randomUUID()}`;
  const alice = await join(instanceId, fx.issue(ALICE));
  const bob = await join(instanceId, fx.issue(BOB));
  const sAlice = await Sock.connect(alice.roomId, alice.sessionToken);
  const sBob = await Sock.connect(bob.roomId, bob.sessionToken);

  // Alice's id is NOT in the list — the whole report is meaningless.
  sAlice.sendCmd(alice.roomId, "rp1", "reportParticipants", { userIds: [BOB.id] });
  await sAlice.next((e) => e.type === "ack" && e.payload.commandId === "rp1");
  // Nobody drops: no presenceChanged may arrive for Bob. Give the room a
  // beat, then confirm Bob's socket is still open.
  await new Promise((r) => setTimeout(r, 400));
  expect(
    sAlice.log.filter((e) => e.type === "presenceChanged" && e.payload.playerId === bob.playerId)
      .length,
  ).toBe(0);
  sAlice.close();
  sBob.close();
});
