// The lobby's invite affordance (Task 40 split from Lobby.tsx for the
// LOC cap): on Discord the channel post via shareInvite — a copied URL
// can't reach a VC member — and on the web the clipboard copy. Discord's
// button is for EVERY member (anyone can pull a friend into the VC); the
// browser link stays host-only so invite secrecy stays with the owner.
import { useState } from "react";
import { shareInvite } from "@yuragoo/platform";
import { discordClientId, getDiscordSdk, platformKind } from "../platform/bootstrap";

export interface InviteButtonProps {
  readonly inviteUrl: string | null;
  readonly isHost: boolean;
  readonly onError: (message: string) => void;
}

export function InviteButton({ inviteUrl, isHost, onError }: InviteButtonProps) {
  const [copied, setCopied] = useState(false);
  if (platformKind() === "discord") {
    return (
      <button
        type="button"
        data-testid="discord-share"
        onClick={() => {
          void getDiscordSdk(discordClientId())
            .then((sdk) => shareInvite(sdk, "ゆらぐー！ このボイスチャンネルであそぼう"))
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
