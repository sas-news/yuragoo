// Client mirror of the server's start gate (Task 24): same checks, same
// order — used ONLY to render the disabled reason on the host's start
// button. The server re-validates everything in assertLobbyStartable.
import { labelKey, type LobbyState, type RoomPlayerView } from "@yuragoo/protocol";
import { type Translate, tx } from "../i18n";

export const startGateReason = (
  lobby: LobbyState,
  members: readonly RoomPlayerView[],
  t: Translate = (ja, vars) => tx("ja", ja, vars),
): string | null => {
  const active = lobby.choices.slice(0, members.length);
  const keys = active.map((c) => labelKey(c.label));
  if (members.length < 2) return t("メンバーが2人いると開始できます");
  const ready = new Set(lobby.ready);
  if (members.some((m) => !ready.has(m.playerId))) return t("全員の準備OKを待っています");
  if (lobby.scenario.trim() === "") return t("シナリオを入力してください");
  if (active.length < members.length) return t("選択肢が足りません");
  if (active.some((c) => labelKey(c.label) === "")) return t("選択肢をすべて入力してください");
  if (new Set(keys).size !== keys.length) return t("選択肢が重複しています");
  return null;
};
