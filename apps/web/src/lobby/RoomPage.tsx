// /r/<roomId> product page (Task 24). Boot: read the invite fragment once
// -> join (or recover the stored session) -> ticket -> WebSocket. The page
// owns the RoomView reducer; children render-only.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapshotPayload } from "@yuragoo/protocol";
import { useLocale, useT } from "../i18n";
import { StatsLink } from "../info/Stats";
import { RoomConnection } from "../net/reconnect";
import { inviteUrl as buildInviteUrl } from "../net/urls";
import { usePipMode } from "../platform/use-pip-mode";
import { LegalFoot } from "../ui/LegalLinks";
import { useVisualViewportHeight } from "../ui/useVisualViewport";
import { Lobby } from "./Lobby";
import { serverErrorText } from "./lobby-errors";
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
  const t = useT();
  const lang = useLocale();
  const roomId = roomIdOf();
  // PIP (Task 48): html[data-pip] flips from Discord's layout event or
  // the pixel tier. The same watch forwards participant ids (server drops
  // members who left); the boot-fetch list flushes once connect() runs.
  const lastParticipantIds = useRef<readonly string[] | null>(null);
  const sendReport = useCallback((ids: readonly string[]): void => {
    lastParticipantIds.current = ids;
    void connRef.current?.send("reportParticipants", { userIds: [...ids] }).catch(() => undefined);
  }, []);
  const pip = usePipMode(sendReport);
  // One-shot page inputs: fragment secret + optional ?name=; ?hb=<ms>
  // compresses the heartbeat for e2e/dev (prod: 15s contract).
  const [inviteSecret] = useState(() => readInviteFragment());
  const [params] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const n = Number(q.get("hb") ?? "");
    return { name: q.get("name"), heartbeatMs: Number.isFinite(n) && n > 0 ? n : undefined };
  });
  const [stage, setStage] = useState<Stage>({ kind: "busy", note: "" });
  const [view, setView] = useState<RoomView>(initialView);
  const [lastError, setLastError] = useState<string | null>(null);
  const connRef = useRef<RoomConnection | null>(null);
  const booted = useRef(false);
  const failStage = useCallback(
    (message: string): void => setStage({ kind: "error", message }),
    [],
  );

  const connect = useCallback(
    async (session: JoinedSession): Promise<void> => {
      const origin = apiOrigin();
      const open = (credentials: JoinedSession) => {
        const conn = new RoomConnection({
          roomId,
          credentials,
          workerOrigin: origin,
          heartbeatMs: params.heartbeatMs,
          onSnapshot: (p: SnapshotPayload, env) =>
            setView((v) => applySnapshot(v, p, env.serverTime, env.gameEpoch)),
          onEvent: (env) => setView((v) => applyEvent(v, env)),
          onError: (p) => setLastError(serverErrorText(p, lang)),
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
          failStage(t("セッションが切れました。招待リンクから入り直してください。"));
          return;
        }
        saveSession(roomId, recovered);
        await open(recovered).catch(() => failStage(t("へやにつながりませんでした。")));
      }
      setStage({ kind: "room" });
      if (lastParticipantIds.current !== null) sendReport(lastParticipantIds.current); // flush boot fetch
    },
    [params, roomId, sendReport, lang, t, failStage],
  );

  const doJoin = useCallback(
    async (secret: string, displayName: string): Promise<void> => {
      setStage({ kind: "busy", note: t("へやに入っています…") });
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
        failStage(
          t("へやに入れませんでした（{detail}）", {
            detail: error instanceof Error ? error.message : "error",
          }),
        );
      }
    },
    [connect, roomId, t, failStage],
  );

  // Boot once: stored session wins, then the invite fragment (auto-join
  // when ?name= is supplied), then the name panel, else invite error.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const session = loadSession(roomId);
    if (session !== null) void connect(session);
    else if (inviteSecret !== null && params.name !== null) {
      void doJoin(inviteSecret, params.name);
    } else if (inviteSecret !== null) {
      setStage({ kind: "name", inviteSecret });
    } else {
      failStage(t("招待リンクから開いてください。"));
    }
    // booted.current makes a mid-boot locale-switch re-run a no-op.
  }, [connect, doJoin, inviteSecret, params, roomId, t, failStage]);

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
  // keyboard, the page shrinks to the visual viewport.
  const vvHeight = useVisualViewportHeight();

  // In-game phases get the full-viewport arena. key=epoch remounts the
  // arena on rematch so per-game visuals reset with the new game.
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
      {stage.kind === "busy" && (
        <p className={styles.note}>{stage.note === "" ? t("つないでいます…") : stage.note}</p>
      )}
      {stage.kind === "left" && <p className={styles.note}>{t("へやを出ました。")}</p>}
      {stage.kind === "closed" && <p className={styles.note}>{t("このへやは閉じられました。")}</p>}
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
      <LegalFoot>
        <StatsLink />
      </LegalFoot>
    </main>
  );
}
