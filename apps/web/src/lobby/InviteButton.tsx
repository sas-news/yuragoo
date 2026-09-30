// The lobby's invite affordance (Task 40 split from Lobby.tsx for the
// LOC cap): on Discord the channel post via shareInvite — a copied URL
// can't reach a VC member — and on the web the clipboard copy. Discord's
// button is for EVERY member (anyone can pull a friend into the VC); the
// browser link stays host-only so invite secrecy stays with the owner.
import { useState } from "react";
import { shareInvite, type ShareInviteResult } from "@yuragoo/platform";
import { discordClientId, getDiscordSdk, platformKind } from "../platform/bootstrap";

export interface InviteButtonProps {
  readonly inviteUrl: string | null;
  readonly isHost: boolean;
  readonly onError: (message: string) => void;
}

// The toast IS the diagnostic — asking players to open iframe devtools
// inside Discord is unreasonable, so the failure path carries its reason
// up from the platform adapter.
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

export function InviteButton({ inviteUrl, isHost, onError }: InviteButtonProps) {
  const [copied, setCopied] = useState(false);
  if (platformKind() === "discord") {
    return (
      <button
        type="button"
        data-testid="discord-share"
        onClick={() => {
          void getDiscordSdk(discordClientId())
            .then((sdk) =>
              shareInvite(sdk, "ゆらぐー！ このボイスチャンネルであそぼう", sdk.instanceId).then(
                (result) => {
                  // "cancelled" = the user closed the share modal — silent,
                  // never an error toast.
                  if (result === "shared" || result === "cancelled") return;
                  onError(inviteErrorText(result));
                },
              ),
            )
            .catch(() => onError("招待できませんでした"));
        }}
      >
        メンバーをよぶ
      </button>
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
