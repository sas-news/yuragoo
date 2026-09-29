// One-shot AI generation outcome folds for the room view (Task 25):
// choicesGenerated surfaces an ephemeral proposal (applying is a separate
// revision-gated lobby edit, never implicit); generationFailed updates
// the spent flag only when the slot was actually burned.
// Split from room-view.ts for the 250-line cap, like view-members.ts.
import type { ServerEnvelope } from "@yuragoo/protocol";
import type { RoomView } from "./room-view";

export type ProposalEvent = Extract<
  ServerEnvelope,
  { type: "choicesGenerated" | "generationFailed" }
>;

export const proposalPatch = (
  view: RoomView,
  env: ProposalEvent,
): Partial<Pick<RoomView, "lobby" | "choiceProposal" | "generationError">> => {
  if (env.type === "choicesGenerated") {
    // The proposal is a suggestion only — landing it in the view never
    // touches the lobby fields; the slot is spent either way.
    return {
      lobby: { ...view.lobby, generationSpent: true },
      choiceProposal: env.payload,
      generationError: null,
    };
  }
  // generationFailed — a burned slot still disables the button.
  const lobby = env.payload.slotSpent ? { ...view.lobby, generationSpent: true } : view.lobby;
  return { lobby, choiceProposal: null, generationError: env.payload };
};
