// Discord SDK error classification (Task 34): the SDK throws ISDKError
// (command rejections) and plain network failures, and Activities surface
// INVALID_COMMAND when the host client predates a command. Every failure
// collapses into a kind + retryability so the UI can explain and offer a
// retry without stringly-typed branching.
export type DiscordErrorKind =
  | "unavailable" // SDK absent or not an Activity environment
  | "denied" // user refused authorize, or the host denied a command
  | "timeout" // SDK/transport did not answer
  | "invalid-command" // host client too old for the command
  | "network" // fetch/exchange transport failure
  | "auth" // token exchange or authenticate failed server-side
  | "unknown";

export interface ClassifiedError {
  readonly kind: DiscordErrorKind;
  readonly retryable: boolean;
}

interface ErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

const codeOf = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as ErrorLike).code;
  return typeof code === "number" ? code : null;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String((error as ErrorLike)?.message ?? error);

// RPC codes we classify: 4002 INVALID_COMMAND and 4008 TIMEOUT.
// Everything unrecognized stays "unknown" — retryable, since transient
// host bugs outnumber true misconfigurations.
export const classifyDiscordError = (error: unknown): ClassifiedError => {
  const code = codeOf(error);
  if (code === 4002) return { kind: "invalid-command", retryable: false };
  if (code === 4008) return { kind: "timeout", retryable: true };
  const message = messageOf(error).toLowerCase();
  if (message.includes("denied") || message.includes("cancel")) {
    return { kind: "denied", retryable: false };
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return { kind: "timeout", retryable: true };
  }
  if (message.includes("discord-auth")) return { kind: "auth", retryable: true };
  if (message.includes("fetch") || message.includes("network")) {
    return { kind: "network", retryable: true };
  }
  return { kind: "unknown", retryable: true };
};

// User-facing copy per kind — soft hiragana, matching the product voice.
// Retryable kinds get a retry affordance; denied and invalid-command
// explain the reason and leave the user in control.
export const discordErrorCopy = (kind: DiscordErrorKind): string => {
  switch (kind) {
    case "unavailable":
      return "Discordアクティビティのなかで ひらいてください";
    case "denied":
      return "Discordでの ログインが キャンセルされました";
    case "timeout":
      return "Discordとの 通信が タイムアウトしました";
    case "invalid-command":
      return "Discordクライアントが ふるいようです。あたらしく してね";
    case "network":
      return "ネットワークが ふあんていです";
    case "auth":
      return "Discordでの にんしょうに しっぱいしました";
    default:
      return "Discordと うまく つながりませんでした";
  }
};
