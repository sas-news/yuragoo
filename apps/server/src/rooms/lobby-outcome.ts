// Shared shape for the lobby-side commit executors (lobby-commit.ts and
// lifecycle-commit.ts): every commit returns the ack ApplyResult plus the
// frames to broadcast, and flags telling transport whether the deadline
// ledger moved (rearm) / the room closed / sockets must drop.
import type { ServerEnvelope } from "@yuragoo/protocol";
import type { CommandHost } from "./commands";
import type { ApplyResult } from "./storage";

export interface LobbyPlanOutcome {
  readonly result: ApplyResult;
  readonly events: readonly ServerEnvelope[];
  readonly committed: boolean;
  readonly closeRoom: boolean;
  readonly dropPlayerIds: readonly string[];
}

export const ackResult = (host: CommandHost, revision: number): ApplyResult => ({
  ack: {
    accepted: true,
    inputSeq: host.booksView()?.meta.inputSeq ?? 0,
    stateRevision: revision,
  },
  events: [],
  stateRevision: revision,
});
