// Task 34 adapter gate: the Discord platform seam end-to-end inside a
// real page. A fake SDK rides __yuragooSdkFactory so the spec observes
// the init order (ready -> authorize -> exchange -> authenticate), the
// classified failures and the layout subscription lifecycle — no real
// Discord transport and no SDK in the browser-only path.
import { expect, test, type Page } from "@playwright/test";

const ROOM_ID = "a".repeat(64);

// The fake SDK: logs every call to window.__fakeLog, keeps subscribed
// listeners in __listeners so the spec can emit events, and reads
// __fakeMode for the failure variants.
const installFakeSdk = async (page: Page, mode: string): Promise<void> => {
  await page.addInitScript((m) => {
    const w = window as unknown as Record<string, unknown>;
    w.__fakeMode = m;
    w.__fakeLog = [];
    w.__listeners = {};
    w.__yuragooSdkFactory = async () => ({
      instanceId: "inst-1",
      channelId: "chan-1",
      ready: async () => {
        (w.__fakeLog as string[]).push("ready");
      },
      commands: {
        authorize: async () => {
          (w.__fakeLog as string[]).push("authorize");
          if (w.__fakeMode === "denied") throw new Error("denied by user");
          if (w.__fakeMode === "invalid") {
            const e = new Error("unrecognized") as Error & { code: number };
            e.code = 4002;
            throw e;
          }
          return { code: "code-1" };
        },
        authenticate: async () => {
          (w.__fakeLog as string[]).push("authenticate");
        },
        shareLink: async () => ({ success: true }),
        openInviteDialog: async () => ({}),
      },
      subscribe: (event: string, listener: unknown) => {
        (w.__fakeLog as string[]).push(`subscribe:${event}`);
        const map = w.__listeners as Record<string, unknown[]>;
        map[event] = [...(map[event] ?? []), listener];
        return Promise.resolve();
      },
      unsubscribe: (event: string) => {
        (w.__fakeLog as string[]).push(`unsubscribe:${event}`);
        return Promise.resolve();
      },
      close: () => {
        (w.__fakeLog as string[]).push("close");
      },
    });
  }, mode);
};

const waitPlatform = (page: Page) =>
  page.waitForFunction(
    () => (window as unknown as { __yuragooPlatform?: unknown }).__yuragooPlatform !== undefined,
    { timeout: 20_000 },
  );

const boot = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __yuragooPlatform: { bootPlatform: (id: string) => Promise<unknown> };
      }
    ).__yuragooPlatform.bootPlatform("client-1"),
  );

test("happy: discord boot runs the ordered auth chain and yields a session", async ({ page }) => {
  await installFakeSdk(page, "ok");
  await page.route("**/api/discord/token", (route) =>
    route.fulfill({ json: { access_token: "at-1" } }),
  );
  // The mounted DiscordGate boots the chain too — pin its outcome (a
  // failed join keeps it on the gate page) so its SDK log cannot leak
  // into the assertion below, and wait for it before measuring ours.
  await page.route("**/api/rooms/discord/join", (route) =>
    route.fulfill({ status: 403, json: { error: "discord-auth" } }),
  );
  await page.goto("/?platform=discord&x=1");
  await waitPlatform(page);
  await page.waitForFunction(
    () => (window as never as { __fakeLog: string[] }).__fakeLog.length >= 3,
    { timeout: 20_000 },
  );
  const result = (await boot(page)) as {
    boot: { kind: string; session: { instanceId: string } | null };
    error: unknown;
  };
  expect(result.error).toBeNull();
  expect(result.boot.kind).toBe("discord");
  expect(result.boot.session?.instanceId).toBe("inst-1");
  // Zero the gate's run and count only this boot()'s chain.
  expect(
    await page.evaluate(async () => {
      const w = window as never as {
        __fakeLog: string[];
        __yuragooPlatform: { bootPlatform: (id: string) => Promise<unknown> };
      };
      w.__fakeLog = [];
      await w.__yuragooPlatform.bootPlatform("client-1");
      return w.__fakeLog;
    }),
  ).toEqual(["ready", "authorize", "authenticate"]);
});

test("happy: browser mode never touches the SDK", async ({ page }) => {
  await page.goto("/");
  await waitPlatform(page);
  const result = (await boot(page)) as {
    boot: { kind: string; sdk: unknown; session: unknown };
    error: unknown;
  };
  expect(result.error).toBeNull();
  expect(result.boot.kind).toBe("browser");
  expect(result.boot.sdk).toBeNull();
  await expect(page.getByTestId("create-room")).toBeVisible();
});

test("failure: denied authorize and INVALID_COMMAND classify without retry", async ({ page }) => {
  for (const [mode, kind] of [
    ["denied", "denied"],
    ["invalid", "invalid-command"],
  ] as const) {
    await installFakeSdk(page, mode);
    await page.goto("/?platform=discord&x=1");
    await waitPlatform(page);
    const result = (await boot(page)) as { error: { kind: string; retryable: boolean } };
    expect(result.error.kind).toBe(kind);
    expect(result.error.retryable).toBe(false);
    await page.goto("about:blank");
  }
});

test("failure: token exchange errors classify as auth and retryable", async ({ page }) => {
  await installFakeSdk(page, "ok");
  await page.route("**/api/discord/token", (route) =>
    route.fulfill({ status: 500, json: { error: "upstream" } }),
  );
  await page.goto("/?platform=discord&x=1");
  await waitPlatform(page);
  const result = (await boot(page)) as { error: { kind: string; retryable: boolean } };
  expect(result.error.kind).toBe("auth");
  expect(result.error.retryable).toBe(true);
});

test("layout: watchLayout delivers events and stop() unsubscribes all", async ({ page }) => {
  await installFakeSdk(page, "ok");
  await page.route("**/api/discord/token", (route) =>
    route.fulfill({ json: { access_token: "at-1" } }),
  );
  await page.goto("/?platform=discord&x=1");
  await waitPlatform(page);
  const seen = await page.evaluate(async () => {
    const w = window as never as {
      __yuragooPlatform: {
        watchLayout: (
          sdk: unknown,
          onChange: (s: { mode: string }) => void,
          onParticipants: (n: number) => void,
        ) => { stop(): void };
        DISCORD_EVENTS: {
          layoutMode: string;
          orientation: string;
          thermal: string;
          participants: string;
        };
      };
      __yuragooSdkFactory: (id: string) => Promise<unknown>;
      __listeners: Record<string, ((d: unknown) => void)[]>;
      __fakeLog: string[];
    };
    const sdk = await w.__yuragooSdkFactory("client-1");
    const out: string[] = [];
    const watcher = w.__yuragooPlatform.watchLayout(
      sdk,
      (s) => out.push(`mode:${s.mode}`),
      (n) => out.push(`count:${n}`),
    );
    await new Promise((r) => setTimeout(r, 50)); // subscribe() resolves async
    for (const l of w.__listeners[w.__yuragooPlatform.DISCORD_EVENTS.layoutMode] ?? []) {
      l({ layout_mode: "GRID" });
    }
    for (const l of w.__listeners[w.__yuragooPlatform.DISCORD_EVENTS.participants] ?? []) {
      l({ participants: [{}, {}, {}] });
    }
    watcher.stop();
    return { out, log: [...w.__fakeLog] };
  });
  expect(seen.out).toContain("mode:grid");
  expect(seen.out).toContain("count:3");
  expect(seen.log.filter((l) => l.startsWith("subscribe:")).length).toBe(4);
  expect(seen.log.filter((l) => l.startsWith("unsubscribe:")).length).toBe(4);
});

test("gate: joins the instance room and lands on /r/<id>", async ({ page }) => {
  await installFakeSdk(page, "ok");
  await page.route("**/api/discord/token", (route) =>
    route.fulfill({ json: { access_token: "at-1" } }),
  );
  await page.route("**/api/rooms/discord/join", (route) =>
    route.fulfill({
      json: {
        roomId: ROOM_ID,
        playerId: "p1",
        sessionToken: "s1",
        reconnectToken: "r1",
        lobbyWaiting: false,
        displayName: "てすと",
      },
    }),
  );
  await page.goto("/?platform=discord&x=1");
  await page.waitForURL(`**/r/${ROOM_ID}**`, { timeout: 20_000 });
  const saved = await page.evaluate((id) => sessionStorage.getItem(`yuragoo:room:${id}`), ROOM_ID);
  expect(saved).toContain("p1");
});
