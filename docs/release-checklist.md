# リリースチェックリスト

デプロイ前に上から順に実行し、結果を記録する。`—` は未実施。
live gate が要る行は `.github/workflows/live-gates.yml` を手動 dispatch
して artifact/manifest を添付する。

| # | 確認 | コマンド/手順 | 結果 |
| --- | --- | --- | --- |
| 1 | lint/型/boundary | `bun run check` | PASS — 378 files / tsc 8tsconfigs / boundaries 0 violations |
| 2 | unit tests | `bun run test:unit` | PASS — 194 tests / 0 fail |
| 3 | workerd tests (DO) | `bun run test:workers` | PASS — 134 tests / 0 fail |
| 4 | web build | `bun run build` | PASS — dist 同梱 privacy/terms、VITE_DISCORD_CLIENT_ID 埋込 |
| 5 | e2e | `bun run test:e2e` | PASS — release spec 2/2 + フルスイート **113/113**（9.6m、commit `9753501` で旧契約テスト更新済み） |
| 6 | Jev eval (live) | `bun run eval:jev -- --suite ja-v1` (JEV_API_KEY 必須) | PASS — 12/12, p95=221ms, `artifacts/eval-ja-v1-rerun.json` |
| 7 | Discord live smoke | `bun run test:discord:live` — 未整備なら skip と明記 | **runner 未実装 → skip**。代替: ユーザー実機 QA 完了報告あり（staging 上で招待/PIP/退出検知/空席化を確認） |
| 8 | deploy smoke | `GET /api/health` = 200 | PASS — prod 200 `{"ok":true}` |
| 9 | public stats | `GET /api/stats` = `pending`/`ok`、payload が数値のみ | PASS — prod `{"status":"pending"}`（閾値未達で正しい） |
| 10 | ops ログ | `logEvent` 行が JSON で、id/body/自由文を含まない | PASS — allowlist 型（eventCode/bucket/errorKind/usage のみ）を F4 で確認 |
| 11 | 削除確認 | close した room の tombstone=done・全データテーブル空 | PASS — `room-deletion.test.ts` + chaos `close` test で tombstone のみ残存を検証 |
| 12 | 予算 cap | JEV/生成 cap が env に設定済み(未設定= fail-closed) | PASS — prod vars: `JEV_DAILY_ATTEMPT_CAP=120`, `GENERATION_DAILY_ATTEMPTS=60` |
| 13 | rollback 手順 | `wrangler rollback --env production` の事前確認 | PASS — prod 2deploy 済み。`wrangler rollback --env production` で version `e3fe53b6`（commit `8a3d262`）へ即時復帰可能 |

## メモ欄

- 対象 version / commit: prod version `000305a4-c13c-4c72-954b-a5c3407af1dd` / commit `9753501`（staging canary `4acf404c`、prod は検証済みcommit `9753501` と一致）
- 実施者 / 日時: Devin（ユーザーの実機 QA 報告含む）/ 2026-10-04
- 気付き・既知の残件:
  - `test:discord:live` runner 未実装（将来の自動化候補）
  - Discord ポータル残作業（ユーザー側）: URL Mappings `/` → `yuragoo.sasnews.dev`、General Information に ToS=`https://yuragoo.sasnews.dev/terms`、Privacy=`https://yuragoo.sasnews.dev/privacy` を登録（2026-10-04 custom domain 化で宛先を workers.dev から差替）。アイコン/背景/カバーは `docs/brand/` に生成済み（動画プレビューは任意のため未作成）
  - 同一 Discord アプリを prod に張り替えたため **staging の Activity は今後使えない**（コードは残る）
  - 独自ドメイン `yuragoo.sasnews.dev` を production worker に custom domain バインド済み（workers.dev 側も `workers_dev: true` で維持）。ALLOWED_ORIGINS は両 origin を許可
