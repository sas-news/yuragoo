// The shared pre-game lobby (Task 24): scenario + per-seat choice drafts
// editable by the host only, the public roster/assignment, ready toggles
// and the host's gated start button. Draft-merge rule (also enforced by
// the server via expectedLobbyRevision): a focused/dirty field is NEVER
// overwritten by an incoming lobbyChanged — clean fields adopt the server
// value, dirty fields keep the local text and show 他の変更あり until the
// server echoes the same value back (which drops the draft).
import { useEffect, useState } from "react";
import type { LobbySettings } from "@yuragoo/protocol";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ChoiceEditor } from "./ChoiceEditor";
import { GameSettings } from "./GameSettings";
import { GenerationControls } from "./GenerationControls";
import { InviteButton } from "./InviteButton";
import { commandErrorText } from "./lobby-errors";
import { startGateReason } from "./lobby-gate";
import { Roster } from "./Roster";
import type { RoomView } from "./room-view";
import { seatedMembers } from "./view-members";
import { ScenarioEditor } from "./ScenarioEditor";
import { useLobbyDrafts } from "./use-lobby-drafts";
import styles from "./Lobby.module.css";

interface LobbyProps {
  readonly roomId: string;
  readonly view: RoomView;
  readonly selfId: string;
  readonly inviteUrl: string | null;
  readonly lastError: string | null;
  readonly sendPatch: (
    patch: {
      scenario?: string;
      choices?: Array<{ choiceId: string; label: string }>;
    },
    expectedLobbyRevision: number,
  ) => Promise<unknown> | undefined;
  readonly setReady: (ready: boolean) => Promise<unknown> | undefined;
  readonly startGame: () => Promise<unknown> | undefined;
  // Task 26: host-only settings patch — the shared view + ready reset
  // come back as the lobbyChanged broadcast.
  readonly updateSettings: (patch: LobbySettings) => Promise<unknown> | undefined;
  // Host-only hand-off to another connected member (Roster renders the
  // per-member button; the server broadcasts hostChanged).
  readonly transferHost: (playerId: string) => Promise<unknown> | undefined;
  // Task 25: one-shot AI generation — request kick + proposal dismiss.
  readonly generateChoices: () => Promise<unknown> | undefined;
  readonly dismissProposal: () => void;
  readonly onLeave: () => void;
}

export function Lobby({
  roomId,
  view,
  selfId,
  inviteUrl,
  lastError,
  sendPatch,
  setReady,
  startGame,
  updateSettings,
  transferHost,
  generateChoices,
  dismissProposal,
  onLeave,
}: LobbyProps) {
  const members = seatedMembers(view);
  const lobby = view.lobby;
  const isHost = view.hostPlayerId === selfId;
  const self = view.players.find((p) => p.playerId === selfId);
  const ready = lobby.ready.includes(selfId);
  const proposal = view.choiceProposal;
  const generationError = view.generationError;
  const [sendError, setSendError] = useState<string | null>(null);
  // The leave button asks before acting — one accidental tap must not
  // eject a member (Task 27 dialog contract).
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Busy spans request->outcome event; it is the double-click guard too.
  const [genBusy, setGenBusy] = useState(false);
  // Command rejections arrive as "code: english" — translate before toast.
  const reportError = (e: Error): void => setSendError(commandErrorText(e));
  const { drafts, fieldValue, fieldConflict, onEdit } = useLobbyDrafts(
    lobby,
    sendPatch,
    setSendError,
  );

  // The generation outcome always arrives as an ordered event — either
  // one clears the busy flag (a rejected command clears it in the catch).
  useEffect(() => {
    if (proposal !== null || generationError !== null) setGenBusy(false);
  }, [proposal, generationError]);

  // Task 25: click-only generation. The apply step is a normal lobby edit
  // on the CURRENT revision — the revision check stays the single gate,
  // so applying never overwrites a lobby that moved underneath us.
  const onGenerate = (): void => {
    setGenBusy(true);
    void generateChoices()?.catch((e: Error) => {
      setGenBusy(false);
      reportError(e);
    });
  };

  const applyProposal = (): void => {
    if (proposal === null) return;
    // Labels past the current rows append prep seats (server allows the
    // next sequential ids, capped at the seat count).
    const edits = proposal.labels.map((label, i) => ({
      choiceId: lobby.choices[i]?.choiceId ?? `c${i}`,
      label,
    }));
    void sendPatch({ choices: edits }, lobby.revision)
      ?.then(() => dismissProposal())
      .catch((e: Error) => reportError(e));
  };

  // Manual seat prep (Task 47): appending the next sequential id with a
  // blank label grows an orphan row — members fill it as they join.
  const addSeat = (): void => {
    void sendPatch(
      { choices: [{ choiceId: `c${lobby.choices.length}`, label: "" }] },
      lobby.revision,
    )?.catch((e: Error) => reportError(e));
  };

  // Client mirror of the server gate — only for the disabled reason; the
  // server re-checks everything authoritatively on startGame.
  const gateReason = startGateReason(lobby, members);

  // generationFailed is a room event everyone receives, but the error
  // surface is host-only — members never see the proposal flow at all.
  const genErrorText =
    generationError === null ? null : `${generationError.message}（${generationError.code}）`;
  const error = sendError ?? lastError ?? (isHost ? genErrorText : null) ?? null;

  return (
    <section className={styles.lobby} data-lobby-revision={lobby.revision}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          へや <code className={styles.code}>{roomId.slice(0, 8)}</code>
        </h1>
        <div className={styles.headerButtons}>
          <InviteButton inviteUrl={inviteUrl} isHost={isHost} onError={setSendError} />
          <button type="button" onClick={() => setConfirmLeave(true)}>
            へやを出る
          </button>
        </div>
      </header>

      {confirmLeave && (
        <Dialog label="退出の確認" onClose={() => setConfirmLeave(false)} testId="leave-confirm">
          <h2 className={styles.dialogTitle} data-autofocus tabIndex={-1}>
            へやを出ますか？
          </h2>
          <p className={styles.note}>
            いまのへやから退出します。もどるには招待リンクがひつようです。
          </p>
          <div className={styles.dialogButtons}>
            <Button variant="primary" onClick={onLeave} data-testid="leave-confirm-yes">
              出る
            </Button>
            <Button onClick={() => setConfirmLeave(false)}>やめる</Button>
          </div>
        </Dialog>
      )}

      <Roster
        view={view}
        selfId={selfId}
        onTransferHost={
          isHost ? (id) => void transferHost(id)?.catch((e: Error) => reportError(e)) : undefined
        }
      />

      <ScenarioEditor
        editable={isHost}
        value={fieldValue("scenario", lobby.scenario)}
        conflict={fieldConflict("scenario")}
        onEdit={(v) => onEdit("scenario", v)}
      />

      <ChoiceEditor
        lobby={lobby}
        members={members}
        editable={isHost}
        drafts={drafts}
        onEdit={onEdit}
        onAddSeat={addSeat}
      />

      {isHost && (
        <GenerationControls
          spent={lobby.generationSpent}
          busy={genBusy}
          scenarioEmpty={lobby.scenario.trim() === ""}
          proposal={proposal}
          currentRevision={lobby.revision}
          onGenerate={onGenerate}
          onApply={applyProposal}
          onDismiss={dismissProposal}
        />
      )}

      {/* Task 26: the shared mode/ending settings — same panel for every
          member; controls are read-only for non-host seats. */}
      <GameSettings
        settings={lobby.settings}
        editable={isHost}
        onChange={updateSettings}
        onError={setSendError}
      />

      <footer className={styles.footer}>
        {self?.lobbyWaiting === true ? (
          <p className={styles.note}>ゲームが始まっています — 観戦待ちです</p>
        ) : (
          <button
            type="button"
            aria-pressed={ready}
            onClick={() => void setReady(!ready)?.catch(reportError)}
          >
            {ready ? "準備OK！" : "準備OKにする"}
          </button>
        )}
        {isHost ? (
          <div className={styles.startWrap}>
            <button
              type="button"
              className={styles.primary}
              disabled={gateReason !== null}
              onClick={() => void startGame()?.catch(reportError)}
            >
              はじめる
            </button>
            {gateReason !== null && <p className={styles.gateReason}>{gateReason}</p>}
          </div>
        ) : (
          <p className={styles.note}>ホストがはじめるのを待っています</p>
        )}
      </footer>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
