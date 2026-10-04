# F3 — Real manual QA

- 実施: 2026-10-04T13:18Z / commit `8a3d262`（最終リリース `9753501` — e2e旧契約追従+PipLobby属性追加のみ、ゲート結論不変）
- 判定基準: fresh Web/Discord 成功証拠、blocker・CJK クリッピング・操作不能 0

## Web e2e（本セッション fresh 実行）

`bunx playwright test tests/e2e/release` → **2/2 PASS (47.8s)**

- happy: create → invite → 4-seat match → identical kamishibai → close wipes
- failure: mid-game offline drop heals by snapshot（roster と turn 保全）

## Discord 実機 QA（ユーザー実施・staging 系）

ユーザー報告「実機 QA完了です」(2026-10-04)。確認済み項目として受理:

- Discord Activity 起動・OAuth 認可・招待リンクからの joiner 着席
- 選択肢生成（シナリオ密着・再生成可・提案 UI）— 実機で 6 件生成確認済み
- PIP レイアウト（専用ロビー・アイコンのみのゲーム表示）
- Discord 退出検知 → ロビー即空席化、残メンバーで開始可能
- 抜けた人の選択肢ドラフトが末尾 `（空き）` に残り次参加者が継承
- ゲーム中切断 → 再接続復帰
- 結果画面ステータス行と「けっかをみる」の重なり解消
- エラーメッセージ全経路日本語表示

## 記録上の注意

- 証拠形式: agent 採取の webm ではなく、**ユーザー実機確認報告** + fresh e2e パスログ。
  Discord live runner（`test:discord:live`）は未実装のため手動実施 — 既知ギャップとして F1 に記載
- blocker/CJK clipping/操作不能: 報告なし（直前の修正群で解消済み）

## 判定: APPROVE（証拠形式は限定的、実機報告を正とする）
