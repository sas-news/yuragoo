// The lobby's invite affordance (Task 40 split from Lobby.tsx for the
// LOC cap): on Discord the channel post via shareInvite — a copied URL
// can't reach a VC member — and on the web the clipboard copy. Discord's
// button is for EVERY member (anyone can pull a friend into the VC); the
// browser link stays host-only so invite secrecy stays with the owner.
import { useState } from "react";
import { shareInvite, type ShareInviteResult } from "@yuragoo/platform";
import { bootPlatform, discordClientId, platformKind } from "../platform/bootstrap";
import styles from "./Lobby.module.css";

export interface InviteButtonProps {
  readonly inviteUrl: string | null;
  readonly isHost: boolean;
  readonly onError: (message: string) => void;
}

// Toasts don't reliably render inside the Discord Activity, so the
// button carries its own persistent status line — the last attempt's
// stage + failure detail stay on screen until the next click (Task 47).
const inviteErrorText = (result: Extract<ShareInviteResult, object>): string => {
  const detail = result.detail === "" ? "" : `（${result.detail}）`;
  switch (result.reason) {
    case "dm":
      return "DM/グループ通話では招待を作れません — サーバーのボイスチャンネルで開いてください";
    case "no-invite-permission":
      return "このチャンネルでは招待を作成する権限がありません";
    default:
      return `招待できませんでした${detail}`;
  }
};

interface InviteStatus {
  readonly kind: "info" | "ok" | "error";
  readonly text: string;
}

export function InviteButton({ inviteUrl, isHost, onError }: InviteButtonProps) {
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
            setStatus({ kind: "info", text: "Discord に接続中…" });
            void (async () => {
              // The room page's SDK never ran the auth chain (the gate
              // did, on a different page). Re-run bootPlatform — prompt:
              // none makes re-consent silent — so shareInvite posts on a
              // ready+authenticated bridge, not a bare one. Each stage is
              // deadline-bounded and reported, so a hang names its step.
              let stage = "sdk-load";
              const { boot, error } = await bootPlatform(discordClientId(), (s) => {
                stage = s;
                setStatus({ kind: "info", text: `Discord に接続中…（${s}）` });
              });
              if (boot.sdk === null || error !== null) {
                fail(`Discord と接続できませんでした（${error?.kind ?? "no-sdk"}:${stage}）`);
                return;
              }
              setStatus({ kind: "info", text: "招待画面をひらいています…" });
              const result = await shareInvite(
                boot.sdk,
                "ゆらぐー！ このボイスチャンネルであそぼう",
                boot.sdk.instanceId,
              );
              if (result === "shared") setStatus({ kind: "ok", text: "招待を送りました" });
              else if (result === "cancelled")
                setStatus({ kind: "info", text: "（キャンセルしました）" });
              else fail(inviteErrorText(result));
            })().catch((e: Error) => fail(`招待できませんでした（${e.message.slice(0, 60)}）`));
          }}
        >
          メンバーをよぶ
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
      {copied ? "コピーしました" : "招待リンクをコピー"}
    </button>
  );
}
