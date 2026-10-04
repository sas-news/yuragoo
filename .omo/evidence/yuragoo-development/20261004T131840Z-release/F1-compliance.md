# F1 — Plan compliance audit

- 実施: 2026-10-04T13:18Z / commit `8a3d262`（最終リリース `9753501` — e2e旧契約追従+PipLobby属性追加のみ、ゲート結論不変）
- 判定基準: 39/39 実装 task と 7/7 phase の証拠が揃い未説明の差分 0

## Phase 単位の完了状況

| phase | tasks | status | 証拠 |
|---|---|---|---|
| W1 基盤 | 1–5 | DONE | `.omo/evidence/yuragoo-development/*` タイムスタンプ dirs、unit suites |
| W2 生命体/Jev sandbox | 6–11 | DONE | `packages/creature`, `packages/ai`, workers tests |
| W3 ローカル対戦 | 12–15 | DONE | `apps/web/src/local/LocalSession`, e2e specs |
| W4 同期ルーム | 16–23 | DONE | `apps/server/src/rooms/*`, 134 worker tests、e2e reconnect specs |
| W5 ロビー編集/生成 | 24–28 | DONE | choice/scenario generation、quota 系 workers tests |
| W6 紙芝居エンディング | 29–33 | DONE | `packages/game-core/src/story/`, `apps/web/src/results/`, `docs/story-contract.md`, `v5-inward/` shots |
| W7 Discord+リリース | 34–39 | DONE | 下記 task 表 |

## W7 task 個別

| task | status | 証拠 |
|---|---|---|
| 34 platform adapter | DONE | `packages/platform/src/`, `apps/web/src/platform/DiscordGate.tsx` |
| 35 Discord OAuth/メンバーシップ | DONE | `/api/discord/token`, `/api/rooms/discord/join`, partial unique seat dedupe |
| 36 Static Assets 配信 | DONE | wrangler env assets + `run_worker_first:["/api/*"]`、deploy scripts |
| 37 実 Discord QA | DONE(2026-10-04) | ユーザー実機 QA 完了報告 — 招待・着席・PIP・退出検知・空席化を staging `429f1c15` 系で確認（F3 参照） |
| 38 公開集計/ops/docs | DONE | `/api/stats`, `observability.ts`, workflows, `docs/{privacy,operations,release-checklist}.md` |
| 39 release gate | DONE | `tests/workers/release-chaos.test.ts` 4件, `tests/e2e/release/` 2件, manifest |

## manifest 以降の差分（説明済み・全て計画 scope 内）

`task-39-release-manifest.json`（commit `636e5202`）以降の実装差分 — 全て元計画の契約内改善であり scope 拡張なし:

- 選択肢生成: プロンプトのシナリオ密着化・パーサー頑健化・再生成可（ワンショット制限撤廃、日次 cap は維持）・`/no_think`・in-flight マーカー
- presence: ロビー切断=即空席化（ユーザー明示承認）/ ゲーム中再接続維持 / 退室ドラフト末尾 orphan 化
- Discord: `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` 退出検知
- エラーメッセージ全経路日本語化
- PIP 専用 `PipLobby` + アイコンのみのゲーム表示
- 公開 `/privacy` `/terms` ページ + index.html メタ（本リリース作業で追加）

## 差分で残る既知ギャップ

- `test:discord:live` コマンドは未実装 — 実機 QA は手動で実施済み（F3）
- 未説明の差分: 0

## 判定: APPROVE
