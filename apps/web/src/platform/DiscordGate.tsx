// Discord entry gate (Task 34): when the page boots inside an Activity,
// the SDK auth chain runs here before any game UI — ready -> authorize
// -> server exchange -> authenticate -> instance join. Failures render
// the classified copy with a retry button; success stashes the room
// session and navigates into /r/<roomId>.
import { useEffect, useState } from "react";
import type { ClassifiedError, DiscordSession } from "@yuragoo/platform";
import { apiOrigin, saveSession } from "../lobby/room-session";
import { Button } from "../ui/Button";
import { bootPlatform, platformErrorText } from "./bootstrap";

export interface DiscordGateProps {
  readonly clientId: string;
}

// POST /api/rooms/discord/join (Task 35 contract): the verified access
// token + activity instance id are the whole proof — no invite secret,
// no self-declared name. The response hands back the seat credentials.
interface JoinedDiscord {
  readonly roomId: string;
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
  readonly lobbyWaiting: boolean;
  readonly displayName: string | null;
}

const joinDiscordRoom = async (session: DiscordSession): Promise<JoinedDiscord> => {
  const res = await fetch(`${apiOrigin()}/api/rooms/discord/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceId: session.instanceId,
      accessToken: session.accessToken,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `http-${res.status}`);
  }
  return (await res.json()) as JoinedDiscord;
};

export function DiscordGate({ clientId }: DiscordGateProps) {
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // attempt re-arms the auth chain on retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry counter
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { boot, error: bootError } = await bootPlatform(clientId);
      if (cancelled) return;
      if (bootError !== null || boot.session === null) {
        setError(bootError ?? { kind: "unavailable", retryable: false });
        return;
      }
      const joined = await joinDiscordRoom(boot.session).catch(
        (e: unknown): Error => (e instanceof Error ? e : new Error(String(e))),
      );
      if (cancelled) return;
      if (joined instanceof Error) {
        setError({ kind: "auth", retryable: true });
        console.log("[discord-gate] join failed", joined.message);
        return;
      }
      saveSession(joined.roomId, {
        playerId: joined.playerId,
        sessionToken: joined.sessionToken,
        reconnectToken: joined.reconnectToken,
        displayName: joined.displayName,
        lobbyWaiting: joined.lobbyWaiting,
      });
      // Carry the whole query — Discord's injected params (frame_id,
      // instance_id, platform, guild_id) must survive the navigation:
      // the room page re-runs platformKind() and new DiscordSDK(), both
      // of which read them straight off location.search.
      window.location.assign(`/r/${joined.roomId}${window.location.search}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, attempt]);

  return (
    <main className="app-shell" data-testid="discord-gate">
      <header className="status-strip">
        <h1>ゆらぐー！</h1>
      </header>
      {error === null ? (
        <p className="status-strip" data-testid="discord-booting">
          Discordと つながっています…
        </p>
      ) : (
        <section className="status-strip" aria-live="polite">
          <p data-testid="discord-error">{platformErrorText(error)}</p>
          {error.retryable && (
            <Button
              data-testid="discord-retry"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              もういちど
            </Button>
          )}
        </section>
      )}
    </main>
  );
}
