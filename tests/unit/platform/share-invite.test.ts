// The lobby invite button's outcomes (Task 42): shareLink's success:false
// is a DISMISSAL — silent, no fallback — while a thrown shareLink drops
// to the native invite dialog, itself gated on a guild channel and
// CREATE_INSTANT_INVITE. Failures carry a typed reason + detail so the
// toast itself is the diagnostic (iframe devtools are impractical).
import { describe, expect, test } from "bun:test";
import { shareInvite, type DiscordSdkLike } from "@yuragoo/platform";

const sdk = (over: {
  shareLink?: () => Promise<{ success?: boolean } | null>;
  openInviteDialog?: () => Promise<unknown>;
  getChannelPermissions?: () => Promise<{ permissions: string }>;
  guildId?: string | null;
}): DiscordSdkLike => ({
  instanceId: "instance-1",
  channelId: "channel-1",
  guildId: over.guildId === undefined ? "guild-1" : over.guildId,
  ready: async () => {},
  commands: {
    authorize: async () => ({ code: "c" }),
    authenticate: async () => ({}),
    shareLink: over.shareLink ?? (async () => ({ success: true })),
    openInviteDialog: over.openInviteDialog ?? (async () => ({})),
    // exactOptionalPropertyTypes: spread so an absent probe stays absent.
    ...(over.getChannelPermissions === undefined
      ? {}
      : { getChannelPermissions: over.getChannelPermissions }),
  },
  subscribe: async () => ({}),
  unsubscribe: async () => ({}),
});

describe("shareInvite", () => {
  test("shared when the modal reports success", async () => {
    expect(await shareInvite(sdk({}), "msg", "iid")).toBe("shared");
  });

  test("success:false is a dismissal — cancelled, never falls back", async () => {
    let dialogCalls = 0;
    const s = sdk({
      shareLink: async () => ({ success: false }),
      openInviteDialog: async () => {
        dialogCalls += 1;
        return {};
      },
    });
    expect(await shareInvite(s, "msg", "iid")).toBe("cancelled");
    expect(dialogCalls).toBe(0);
  });

  test("thrown shareLink falls back to the invite dialog", async () => {
    let dialogCalls = 0;
    const s = sdk({
      shareLink: async () => {
        throw new Error("unsupported");
      },
      openInviteDialog: async () => {
        dialogCalls += 1;
        return {};
      },
    });
    expect(await shareInvite(s, "msg", "iid")).toBe("shared");
    expect(dialogCalls).toBe(1);
  });

  test("DM context (guildId null) skips the dialog — it would throw", async () => {
    let dialogCalls = 0;
    const s = sdk({
      guildId: null,
      shareLink: async () => {
        throw new Error("unsupported");
      },
      openInviteDialog: async () => {
        dialogCalls += 1;
        return {};
      },
    });
    expect(await shareInvite(s, "msg", "iid")).toEqual({
      reason: "dm",
      detail: "unsupported",
    });
    expect(dialogCalls).toBe(0);
  });

  test("missing CREATE_INSTANT_INVITE skips the dialog", async () => {
    const s = sdk({
      shareLink: async () => {
        throw new Error("unsupported");
      },
      getChannelPermissions: async () => ({ permissions: "0" }),
    });
    expect(await shareInvite(s, "msg", "iid")).toEqual({
      reason: "no-invite-permission",
      detail: "unsupported",
    });
  });

  test("invite permission bit set lets the dialog run", async () => {
    let dialogCalls = 0;
    const s = sdk({
      shareLink: async () => {
        throw new Error("unsupported");
      },
      getChannelPermissions: async () => ({ permissions: "1" }),
      openInviteDialog: async () => {
        dialogCalls += 1;
        return {};
      },
    });
    expect(await shareInvite(s, "msg", "iid")).toBe("shared");
    expect(dialogCalls).toBe(1);
  });

  test("both paths failing reports the dialog error", async () => {
    const s = sdk({
      shareLink: async () => {
        throw new Error("unsupported");
      },
      openInviteDialog: async () => {
        throw new Error("denied");
      },
    });
    expect(await shareInvite(s, "msg", "iid")).toEqual({
      reason: "error",
      detail: "denied",
    });
  });
});
