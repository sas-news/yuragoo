// Task 24: startGame is gated on the shared lobby ledger — before any
// startGame send, the host (first seat) fills scenario + every grown
// choice label at the current revision and every member readies up.
import type { Seat } from "./mp-bridge";
import { send } from "./mp-bridge";

export const armLobby = async (
  seats: readonly Seat[],
  settings?: Record<string, unknown>,
): Promise<void> => {
  const host = seats[0];
  if (host === undefined) throw new Error("armLobby needs at least one seat");
  await host.page.evaluate(async (id) => {
    const view = window.__roomBridge?.clients[id];
    if (view === undefined) throw new Error("armLobby: no client view");
    let lobby = view.snapshot?.lobby;
    for (const e of view.events) {
      if (e.type === "lobbyChanged") lobby = e.payload;
    }
    if (lobby === undefined) throw new Error("armLobby: no lobby state yet");
    await window.__roomBridge?.send(id, "updateLobbyContent", {
      scenario: "夜のおやつ会議",
      choices: lobby.choices.map((c, i) => ({ choiceId: c.choiceId, label: `選択肢${i + 1}` })),
      expectedLobbyRevision: lobby.revision,
    });
  }, host.id);
  // Task 26: settings ride updateLobby — the shared view and the create
  // settings agree by construction; startGame only confirms them.
  if (settings !== undefined && Object.keys(settings).length > 0) {
    await send(host, "updateLobby", settings);
  }
  for (const s of seats) await send(s, "setReady", { ready: true });
};

export const armedStart = async (
  seats: readonly Seat[],
  settings: Record<string, unknown>,
): Promise<void> => {
  await armLobby(seats, settings);
  const host = seats[0];
  if (host === undefined) throw new Error("armedStart needs at least one seat");
  await send(host, "startGame", {});
};
