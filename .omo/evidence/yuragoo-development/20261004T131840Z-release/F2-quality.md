# F2 — Code quality review

- 実施: 2026-10-04T13:18Z / commit `8a3d262`（最終リリース `9753501` — e2e旧契約追従+PipLobby属性追加のみ、ゲート結論不変）
- 判定基準: check/build/unit/workers 成功、HIGH以上の未解決欠陥 0、拒否系の抜き打ち実測

## 全スイート実測（本セッションで再実行）

| suite | command | result |
|---|---|---|
| check | `bun run check` | PASS — biome 378 files / tsc 8 tsconfigs / check-boundaries 329 files 0 violations |
| unit | `bun run test:unit` | PASS — 194 tests / 26 files / 0 fail |
| workers | `bun run test:workers` | PASS — 134 tests / 27 files / 0 fail（`room-expired` uncaught traces は expired-room 意図的検証由来、全テスト緑） |
| build | `bun run build` | PASS — vite 674ms、dist/privacy + dist/terms 同梱、VITE_DISCORD_CLIENT_ID 埋込確認 |
| e2e release | `bunx playwright test tests/e2e/release` | PASS — 2/2（happy: create→invite→4-seat→kamishibai→close wipes / failure: mid-game offline drop heals by snapshot） |
| e2e full suite | `npx playwright test` | PASS — **113/113 (9.6m)**。旧契約テストは commit `9753501` で仕様追従（ロビー空席化/モード限定ready reset/PIP表示）。PipLobby に data-player-id 追加（実コード微修正） |

## 拒否系 抜き打ち（計画 F2.failure 指定4系統）

| 指定ケース | 実測先 | 結果 |
|---|---|---|
| unauthorized host | `tests/workers/room-settings.test.ts` 他（`not-host` 拒否） | PASS — 全スイート内で検証済み |
| 旧 epoch / stale | `tests/workers/room-websocket.test.ts`, `room-reopen.test.ts` | PASS |
| 上限超過（cap） | `tests/workers/choice-generation.test.ts`（`GENERATION_DAILY_ATTEMPTS` fail-closed）、quota 予約系 | PASS |
| room delete 後の遅着 | `tests/workers/release-chaos.test.ts` `close: every entrypoint refuses and the wipe leaves only a tombstone`、`room-deletion.test.ts` | PASS — tombstone のみ残存、再初期化なし |

加えて `release-chaos.test.ts`: 10 rooms×6 members 負荷 / alarm 再起動耐性 / abuse（満員・不正 invite・不正 reconnect・ghost apply 拒否）全て PASS。

## 直近の品質修正（本リリース区間）

- ロビー切断=即空席化 / ゲーム中は再接続可（`presence-vacate.ts` / `lifecycle-commit.ts`）
- 退室者ドラフトを末尾 orphan 化（`lobby.ts` `onMemberLeft` — 座席位置継承による誤アサイン防止）
- 生成パーサー頑健化（Qwen 実出力包み 11 キー・多層 unwrap・テキストリスト救済）+ `/no_think` + max_tokens 2048
- エラーメッセージ日本語化一掃（`lobby-errors.ts` 全経路適用）
- Discord 参加者退出検知（`reportParticipants` → `participant-drop.ts`、誤検知は再接続で自己修復）

## 未解決 HIGH 欠陥

0。残存警告: Stats 系 CSS の specificity warning 1件（既存・非ブロッキング）。

## 判定: APPROVE
