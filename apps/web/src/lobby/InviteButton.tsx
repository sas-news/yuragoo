// The lobby's invite affordance (Task 40 split from Lobby.tsx for the
// LOC cap): on Discord the channel post via shareInvite — a copied URL
// can't reach a VC member — and on the web the clipboard copy. Discord's
// button is for EVERY member (anyone can pull a friend into the VC); the
// browser link stays host-only so invite secrecy stays with the owner.
import { useState } from "react";
import { shareInvite, type ShareInviteResult } from "@yuragoo/platform";
import { type Locale, useLocale, useT, tx } from "../i18n";
import { discordClientId, getDiscordSdk, platformKind } from "../platform/bootstrap";
import styles from "./Lobby.module.css";

export interface InviteButtonProps {
  readonly inviteUrl: string | null;
  readonly isHost: boolean;
  readonly onError: (message: string) => void;
}

// Toasts don't reliably render inside the Discord Activity, so the
// button carries its own persistent status line — the last attempt's
// stage + failure detail stay on screen until the next click (Task 47).
const inviteErrorText = (result: Extract<ShareInviteResult, object>, lang: Locale): string => {
  const detail = result.detail === "" ? "" : `（${result.detail}）`;
  switch (result.reason) {
    case "dm":
      return tx(
        lang,
        "DM/グループ通話では招待を作れません — サーバーのボイスチャンネルで開いてください",
      );
    case "no-invite-permission":
      return tx(lang, "このチャンネルでは招待を作成する権限がありません");
    default:
      return tx(lang, "招待できませんでした{detail}", { detail });
  }
};

interface InviteStatus {
  readonly kind: "info" | "ok" | "error";
  readonly text: string;
}

export function InviteButton({ inviteUrl, isHost, onError }: InviteButtonProps) {
  const t = useT();
  const lang = useLocale();
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<InviteStatus | null>(null);
  if (platformKind() === "discord") {
    const fail = (text: string): void => {
      setStatus({ kind: "error", text });
      onError(text);
    };
    return (
      <span className={styles.inviteWrap}>
        <button
          type="button"
          data-testid="discord-share"
          onClick={() => {
            setStatus({ kind: "info", text: t("Discord に接続中…（sdk-load）") });
            void (async () => {
              // The gate's SPA hand-off keeps the module-memoized,
              // already-authenticated SDK — authorize may only run ONCE
              // per bridge (a second call throws INVALID_COMMAND), so
              // shareInvite just needs the ready handshake, no re-auth.
              const sdk = await Promise.race([
                getDiscordSdk(discordClientId()),
                new Promise<never>((_r, reject) =>
                  setTimeout(() => reject(new Error("timeout:sdk-load")), 15_000),
                ),
              ]);
              setStatus({ kind: "info", text: t("招待画面をひらいています…") });
              const result = await shareInvite(
                sdk,
                t("ゆらぐー！ このボイスチャンネルであそぼう"),
                sdk.instanceId,
              );
              if (result === "shared") setStatus({ kind: "ok", text: t("招待を送りました") });
              else if (result === "cancelled")
                setStatus({ kind: "info", text: t("（キャンセルしました）") });
              else fail(inviteErrorText(result, lang));
            })().catch((e: Error) =>
              fail(t("招待できませんでした（{detail}）", { detail: e.message.slice(0, 60) })),
            );
          }}
        >
          {t("メンバーをよぶ")}
        </button>
        {status !== null && (
          <p
            className={status.kind === "error" ? styles.inviteError : styles.inviteStatus}
            role="status"
            aria-live="polite"
            data-testid="invite-status"
          >
            {status.text}
          </p>
        )}
      </span>
    );
  }
  if (!isHost || inviteUrl === null) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(inviteUrl).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? t("コピーしました") : t("招待リンクをコピー")}
    </button>
  );
}
