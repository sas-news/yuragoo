// Command rejections surface as Error("code: message") with the server's
// English text — the toast shows localized text for the codes a lobby
// action can actually hit (Task 46). Unknown codes keep the raw message
// so nothing is swallowed.

const TEXT: Readonly<Record<string, string>> = {
  "lobby-scenario-empty": "シナリオを入力してから生成できます",
  "generation-spent": "このへやでは選択肢を生成済みです",
  "not-host": "ホストだけが操作できます",
  "bad-state": "ゲーム開始後は変更できません",
  "already-started": "ゲームはすでに始まっています",
  "lobby-too-few": "メンバーが2人いると開始できます",
  "lobby-not-ready": "全員の準備OKを待っています",
  "lobby-choice-dup": "選択肢が重複しています",
  "lobby-choice-empty": "空の選択肢は保存できません",
  "lobby-choice-missing": "変更が古い — いったん画面を更新してください",
  "lobby-revision-conflict": "変更が古い — いったん画面を更新してください",
  "too-long": "入力が長すぎます",
  "not-a-member": "このへやのメンバーではありません",
};

// e.message is "<code>: <message>" for command rejections; anything
// else (network, timeouts) passes through unchanged.
export const commandErrorText = (error: Error): string => {
  const sep = error.message.indexOf(":");
  if (sep <= 0) return error.message;
  const code = error.message.slice(0, sep);
  const mapped = TEXT[code];
  return mapped === undefined ? error.message : mapped;
};
