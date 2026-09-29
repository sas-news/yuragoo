// One-shot AI generation outcome folds for the room view (Task 25/44):
// choicesGenerated / scenarioGenerated surface an ephemeral proposal
// (applying is a separate revision-gated lobby edit, never implicit),
// generationFailed updates only the spent flag of the slot it burned.
// Split from room-view.ts for the 250-line cap, like view-members.ts.
import type { ServerEnvelope } from "@yuragoo/protocol";
import type { RoomView } from "./room-view";

export type ProposalEvent = Extract<
  ServerEnvelope,
  { type: "choicesGenerated" | "scenarioGenerated" | "generationFailed" }
>;

export const proposalPatch = (
  view: RoomView,
  env: ProposalEvent,
): Partial<Pick<RoomView, "lobby" | "choiceProposal" | "scenarioProposal" | "generationError">> => {
  if (env.type === "choicesGenerated") {
    // The proposal is a suggestion only — landing it in the view never
    // touches the lobby fields; the slot is spent either way.
    return {
      lobby: { ...view.lobby, generationSpent: true },
      choiceProposal: env.payload,
      generationError: null,
    };
  }
  if (env.type === "scenarioGenerated") {
    return {
      lobby: { ...view.lobby, scenarioSpent: true },
      scenarioProposal: env.payload,
      generationError: null,
    };
  }
  // generationFailed — a burned slot still disables its button; the scope
  // says which one (absent = choices, the only pre-Task-44 slot).
  const lobby = env.payload.slotSpent
    ? env.payload.scope === "scenario"
      ? { ...view.lobby, scenarioSpent: true }
      : { ...view.lobby, generationSpent: true }
    : view.lobby;
  return { lobby, choiceProposal: null, scenarioProposal: null, generationError: env.payload };
};
