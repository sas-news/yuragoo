// /r/<roomId> product page (Task 24). Boot sequence mirrors room-bridge.ts:
// read the invite fragment once -> join (or recover the stored session) ->
// ticket -> WebSocket through RoomConnection (rotation + reconnect inside).
// The page owns the RoomView reducer; Lobby and RoomGame are render-only.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapshotPayload } from "@yuragoo/protocol";
import { StatsLink } from "../info/Stats";
import { RoomConnection } from "../net/reconnect";
import { inviteUrl as buildInviteUrl } from "../net/urls";
import { usePipMode } from "../platform/use-pip-mode";
import { useVisualViewportHeight } from "../ui/useVisualViewport";
import { Lobby } from "./Lobby";
import { NamePanel } from "./NamePanel";
import { PipLobby } from "./PipLobby";
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

export default function RoomPage() {
  const roomId = roomIdOf();
  // PIP (Task 48): html[data-pip] flips from Discord's layout event or
  // the pixel tier. The same watch forwards participant ids so the server
  // drops members who left the Activity; the boot-fetch list is kept and
  // flushed once connect() finishes.
  const lastParticipantIds = useRef<readonly string[] | null>(null);
  const sendReport = useCallback((ids: readonly string[]): void => {
    lastParticipantIds.current = ids;
    void connRef.current?.send("reportParticipants", { userIds: [...ids] }).catch(() => undefined);
  }, []);
  const pip = usePipMode(sendReport);
  // One-shot page inputs: fragment secret + optional ?name=.
  const [inviteSecret] = useState(() => readInviteFragment());
  const [nameParam] = useState(() => new URLSearchParams(window.location.search).get("name"));
  // `?hb=<ms>` compresses the heartbeat for e2e/dev (prod: 15s contract).
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
            // A live room flips to "closed"; an intentional leave wins.
            setStage((s) =>
              connRef.current?.finished === true && (s.kind === "room" || s.kind === "busy")
                ? { kind: "closed" }
                : s,
            );
          },
          onReconnect: () => saveRotated(roomId, conn.credentials),
        });
        connRef.current = conn;
        // e2e seam: raw command access on the page's own connection.
        if (import.meta.env.MODE === "e2e") {
          (window as unknown as { __roomConn?: RoomConnection }).__roomConn = conn;
        }
        return conn.connect();
      };
      try {
        await open(session);
      } catch {
        // Stored pair may be dead server-side — rotate once, then give up.
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
        await open(recovered).catch(() =>
          setStage({ kind: "error", message: "へやにつながりませんでした。" }),
        );
      }
      setStage({ kind: "room" });
      if (lastParticipantIds.current !== null) sendReport(lastParticipantIds.current); // flush boot fetch
    },
    [heartbeatMs, roomId, sendReport],
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

  // Boot once: stored session wins, then the invite fragment (auto-join
  // when ?name= is supplied), then the name panel, else invite-required.
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
    // The socket outlives the component only through page navigation.
  }, [connect, doJoin, inviteSecret, nameParam, roomId]);

  const selfId = connRef.current?.credentials.playerId ?? "";

  const onLeave = useCallback(() => {
    const conn = connRef.current;
    void conn
      ?.leaveRoom()
      .then(() => {
        // Flip the stage first — stop()'s onClose must not overwrite it.
        clearSession(roomId);
        setStage({ kind: "left" });
        conn.stop();
      })
      .catch((e: Error) => setLastError(e.message));
  }, [roomId]);

  // The shared invite carries env params (api/hb) but never per-user data.
  const inviteUrl = inviteSecret === null ? null : buildInviteUrl(roomId, inviteSecret);

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
        pip={pip}
        view={view}
        selfId={selfId}
        submitText={(text: string) => connRef.current?.send("submitText", { text })}
        pass={() => connRef.current?.send("pass", {})}
        backToLobby={() => connRef.current?.send("backToLobby", {})}
        closeRoom={() => connRef.current?.send("closeRoom", {})}
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
      {stage.kind === "room" && pip ? (
        <PipLobby
          view={view}
          selfId={selfId}
          inviteUrl={inviteUrl}
          lastError={lastError}
          setReady={(r) => connRef.current?.setReady(r)}
          startGame={() => connRef.current?.startGame()}
          onLeave={onLeave}
        />
      ) : stage.kind === "room" ? (
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
      ) : null}
      <p className={styles.note}>
        <StatsLink />
      </p>
    </main>
  );
}
