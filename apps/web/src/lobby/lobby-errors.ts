// Command rejections surface as Error("code: message") with the server's
// English text — the toast shows localized text for the codes a lobby
// action can actually hit (Task 46). Unknown codes keep the raw message
// (with the code appended) so nothing is swallowed.

const TEXT: Readonly<Record<string, string>> = {
  "lobby-scenario-empty": "シナリオを入力してから生成できます",
  "generation-spent": "このへやでは選択肢を生成済みです",
  "generation-unavailable": "いまは生成できません — あとで試してください",
  "generation-timeout": "生成が時間切れになりました — もう一度試してください",
  "generation-upstream": "生成サーバーが応答しませんでした — もう一度試してください",
  "generation-busy": "いま生成中です — 少し待ってください",
  "not-host": "ホストだけが操作できます",
  "bad-state": "いまはその操作はできません",
  "already-started": "ゲームはすでに始まっています",
  "already-created": "ゲームはすでに作成済みです",
  "not-created": "まだゲームが始まっていません",
  "not-playing": "ゲームが進行中ではありません",
  "not-your-turn": "いまはあなたの番ではありません",
  "already-posted": "すでに送信済みです",
  "too-late": "締め切りを過ぎています",
  "lobby-too-few": "メンバーが2人いると開始できます",
  "lobby-not-ready": "全員の準備OKを待っています",
  "lobby-choice-dup": "選択肢が重複しています",
  "lobby-choice-empty": "空の選択肢は保存できません",
  "lobby-choice-missing": "変更が古い — いったん画面を更新してください",
  "lobby-revision-conflict": "変更が古い — いったん画面を更新してください",
  "too-long": "入力が長すぎます",
  "not-a-member": "このへやのメンバーではありません",
  "unknown-choice": "その選択肢はありません",
  "unknown-player": "そのプレイヤーはいません",
  "room-closed": "このへやは閉じられました",
  "room-expired": "このへやは期限切れです",
  "room-full": "このへやは満員です",
  "rate-limited": "送信が多すぎます — 少し待ってください",
  "idempotency-conflict": "同じ操作が重複して送信されました",
  internal: "内部エラーが発生しました",
};

// e.message is "<code>: <message>" for command rejections; anything
// else (network, timeouts) passes through unchanged.
export const commandErrorText = (error: Error): string => {
  const sep = error.message.indexOf(":");
  if (sep <= 0) return error.message;
  const code = error.message.slice(0, sep);
  const mapped = TEXT[code];
  return mapped === undefined ? `${error.message.slice(sep + 1).trim()}（${code}）` : mapped;
};

// Server-sent `error` frames (no pending command) carry the same
// code:english pair — localize by code, keep unknowns diagnosable.
export const serverErrorText = (payload: { code: string; message: string }): string =>
  TEXT[payload.code] ?? `${payload.message}（${payload.code}）`;
