// Task 44: the scenario-generation flow for the lobby — request kick,
// busy flag, and the proposal's apply step (a normal revision-gated
// updateLobbyContent, identical contract to the choices proposal).
// Kept out of Lobby.tsx for the 250-line cap.
import { useEffect, useState } from "react";
import type { RoomView, ScenarioProposal } from "./room-view";

export interface ScenarioGenerationUi {
  readonly spent: boolean;
  readonly busy: boolean;
  readonly proposal: ScenarioProposal | null;
  readonly currentRevision: number;
  readonly onGenerate: () => void;
  readonly onApply: () => void;
  readonly onDismiss: () => void;
}

export const useScenarioGeneration = (
  view: RoomView,
  sendPatch: (
    patch: { scenario?: string },
    expectedLobbyRevision: number,
  ) => Promise<unknown> | undefined,
  generateScenario: () => Promise<unknown> | undefined,
  dismissProposal: () => void,
  onError: (message: string) => void,
): ScenarioGenerationUi => {
  const [busy, setBusy] = useState(false);
  const proposal = view.scenarioProposal;
  const error = view.generationError;

  // The outcome always arrives as an ordered event — either kind clears
  // the busy flag (a rejected command clears it in the catch below).
  useEffect(() => {
    if (proposal !== null || error !== null) setBusy(false);
  }, [proposal, error]);

  return {
    spent: view.lobby.scenarioSpent,
    busy,
    proposal,
    currentRevision: view.lobby.revision,
    onGenerate: () => {
      setBusy(true);
      void generateScenario()?.catch((e: Error) => {
        setBusy(false);
        onError(e.message);
      });
    },
    onApply: () => {
      if (proposal === null) return;
      void sendPatch({ scenario: proposal.scenario }, view.lobby.revision)
        ?.then(() => dismissProposal())
        .catch((e: Error) => onError(e.message));
    },
    onDismiss: dismissProposal,
  };
};
