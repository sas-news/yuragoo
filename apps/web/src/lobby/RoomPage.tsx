// /r/<roomId> product page (Task 24). Boot sequence mirrors room-bridge.ts:
// read the invite fragment once -> join (or recover the stored session) ->
// ticket -> WebSocket through RoomConnection (rotation + reconnect inside).
// The page owns the RoomView reducer; Lobby and RoomGame are render-only.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapshotPayload } from "@yuragoo/protocol";
import { RoomConnection } from "../net/reconnect";
import { useVisualViewportHeight } from "../ui/useVisualViewport";
import { Lobby } from "./Lobby";
import { NamePanel } from "./NamePanel";
import { RoomGame } from "./RoomGame";
import {
  apiOrigin,
  clearSession,
  type JoinedSession,
  joinRoom,
  loadSession,
  readInviteFragment,
  recoverSession,
  saveName,
  saveRotated,
  saveSession,
} from "./room-session";
import { applyEvent, applySnapshot, initialView, type RoomView } from "./room-view";
import styles from "./Lobby.module.css";

type Stage =
  | { readonly kind: "name"; readonly inviteSecret: string }
  | { readonly kind: "busy"; readonly note: string }
  | { readonly kind: "room" }
  | { readonly kind: "left" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly message: string };

const roomIdOf = (): string => window.location.pathname.split("/")[2] ?? "";

// location.search minus the per-user ?name= param — the environment
// overrides (api/hb) ride the invite link, user data never does.
const inviteQuery = (): string => {
  const params = new URLSearchParams(window.location.search);
  params.delete("name");
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
};

export default function RoomPage() {
  const roomId = roomIdOf();
  // One-shot page inputs: the fragment secret and an optional ?name=.
  const [inviteSecret] = useState(() => readInviteFragment());
  const [nameParam] = useState(() => new URLSearchParams(window.location.search).get("name"));
  // `?hb=<ms>` compresses the presence heartbeat for e2e/dev workers whose
  // lease is shortened; production leaves it undefined (15s contract).
  const [heartbeatMs] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("hb");
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  });
  const [stage, setStage] = useState<Stage>({ kind: "busy", note: "つないでいます…" });
  const [view, setView] = useState<RoomView>(initialView);
  const [lastError, setLastError] = useState<string | null>(null);
  const connRef = useRef<RoomConnection | null>(null);
  const booted = useRef(false);

  const connect = useCallback(
    async (session: JoinedSession): Promise<void> => {
      const origin = apiOrigin();
      const open = (credentials: JoinedSession) => {
        const conn = new RoomConnection({
          roomId,
          credentials,
          workerOrigin: origin,
          heartbeatMs,
          onSnapshot: (p: SnapshotPayload, env) =>
            setView((v) => applySnapshot(v, p, env.serverTime, env.gameEpoch)),
          onEvent: (env) => setView((v) => applyEvent(v, env)),
          onError: (p) => setLastError(p.message),
          onClose: () => {
            // Only a live room flips to the closed screen — an intentional
            // leave already showed "left" and must not be overwritten.
            setStage((s) =>
              connRef.current?.finished === true && (s.kind === "room" || s.kind === "busy")
                ? { kind: "closed" }
                : s,
            );
          },
          onReconnect: () => saveRotated(roomId, conn.credentials),
        });
        connRef.current = conn;
        // e2e seam (same shape as room-bridge): raw command access on the
        // page's own connection for rejection-path probes. e2e build only.
        if (import.meta.env.MODE === "e2e") {
          (window as unknown as { __roomConn?: RoomConnection }).__roomConn = conn;
        }
        return conn.connect();
      };
      try {
        await open(session);
      } catch {
        // The stored pair may have died server-side — rotate once before
        // giving up (recoverSession burns the reconnect token).
        const recovered = await recoverSession(origin, roomId, session).catch(() => null);
        if (recovered === null) {
          clearSession(roomId);
          setStage({
            kind: "error",
            message: "セッションが切れました。招待リンクから入り直してください。",
          });
          return;
        }
        saveSession(roomId, recovered);
        await open(recovered).catch(() => {
          setStage({ kind: "error", message: "へやにつながりませんでした。" });
        });
      }
      setStage({ kind: "room" });
    },
    [heartbeatMs, roomId],
  );

  const doJoin = useCallback(
    async (secret: string, displayName: string): Promise<void> => {
      setStage({ kind: "busy", note: "へやに入っています…" });
      try {
        const session = await joinRoom(
          apiOrigin(),
          roomId,
          secret,
          displayName.trim() === "" ? null : displayName.trim(),
        );
        saveName(displayName); // the name panel opens prefilled next time
        saveSession(roomId, session);
        await connect(session);
      } catch (error) {
        setStage({
          kind: "error",
          message: `へやに入れませんでした（${error instanceof Error ? error.message : "error"}）`,
        });
      }
    },
    [connect, roomId],
  );

  // Boot once (StrictMode double-effects included): stored session wins,
  // then the invite fragment (auto-join when ?name= is supplied), then the
  // name panel, else the invite-required error.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const session = loadSession(roomId);
    if (session !== null) void connect(session);
    else if (inviteSecret !== null && nameParam !== null) {
      void doJoin(inviteSecret, nameParam);
    } else if (inviteSecret !== null) {
      setStage({ kind: "name", inviteSecret });
    } else {
      setStage({ kind: "error", message: "招待リンクから開いてください。" });
    }
    // The socket outlives the component only through page navigation —
    // there is no client-side route change on this page.
  }, [connect, doJoin, inviteSecret, nameParam, roomId]);

  const selfId = connRef.current?.credentials.playerId ?? "";

  const onLeave = useCallback(() => {
    const conn = connRef.current;
    void conn
      ?.leaveRoom()
      .then(() => {
        // Flip the stage first — stop() closes the socket, and its onClose
        // must not overwrite "left" with the generic closed screen.
        clearSession(roomId);
        setStage({ kind: "left" });
        conn.stop();
      })
      .catch((e: Error) => setLastError(e.message));
  }, [roomId]);

  // The shared invite carries the environment params (api/hb) but never
  // per-user data: a host who joined through ?name= must not hand out a
  // link that auto-names every invitee.
  const inviteUrl =
    inviteSecret === null
      ? null
      : `${window.location.origin}/r/${roomId}${inviteQuery()}#${inviteSecret}`;

  // IME fallback (Task 27): where 100dvh does not track the software
  // keyboard, the page shrinks to the visual viewport so inputs and the
  // footer controls are never pushed underneath it.
  const vvHeight = useVisualViewportHeight();

  // In-game phases get the full-viewport arena (creature stage + bottom
  // tray) — the lobby card column must not wrap it. key=epoch remounts
  // the arena on rematch so per-game visuals (post-reaction seen-set,
  // seat anchors) reset with the new game.
  if (stage.kind === "room" && view.phase !== "lobby") {
    return (
      <RoomGame
        key={view.epoch}
        view={view}
        selfId={selfId}
        submitText={(text: string) => connRef.current?.send("submitText", { text })}
        pass={() => connRef.current?.send("pass", {})}
        backToLobby={() => connRef.current?.send("backToLobby", {})}
      />
    );
  }

  return (
    <main
      className={styles.page}
      style={vvHeight === undefined ? undefined : { minBlockSize: `${vvHeight}px` }}
    >
      {stage.kind === "name" && (
        <NamePanel onJoin={(name) => void doJoin(stage.inviteSecret, name)} />
      )}
      {stage.kind === "busy" && <p className={styles.note}>{stage.note}</p>}
      {stage.kind === "left" && <p className={styles.note}>へやを出ました。</p>}
      {stage.kind === "closed" && <p className={styles.note}>このへやは閉じられました。</p>}
      {stage.kind === "error" && <p className={styles.note}>{stage.message}</p>}
      {stage.kind === "room" && (
        <Lobby
          roomId={roomId}
          view={view}
          selfId={selfId}
          inviteUrl={inviteUrl}
          lastError={lastError}
          sendPatch={(patch, rev) => connRef.current?.updateLobbyContent(patch, rev)}
          setReady={(r) => connRef.current?.setReady(r)}
          startGame={() => connRef.current?.startGame()}
          updateSettings={(patch) => connRef.current?.updateLobby(patch)}
          transferHost={(id: string) => connRef.current?.send("transferHost", { playerId: id })}
          generateChoices={() => connRef.current?.generateChoices()}
          dismissProposal={() => setView((v) => ({ ...v, choiceProposal: null }))}
          onLeave={onLeave}
        />
      )}
    </main>
  );
}
