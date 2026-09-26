# リリースチェックリスト

デプロイ前に上から順に実行し、結果を記録する。`—` は未実施。
live gate が要る行は `.github/workflows/live-gates.yml` を手動 dispatch
して artifact/manifest を添付する。

| # | 確認 | コマンド/手順 | 結果 |
| --- | --- | --- | --- |
| 1 | lint/型/boundary | `bun run check` | — |
| 2 | unit tests | `bun run test:unit` | — |
| 3 | workerd tests (DO) | `bun run test:workers` | — |
| 4 | web build | `bun run build` | — |
| 5 | e2e | `bun run test:e2e` | — |
| 6 | Jev eval (live) | `bun run eval:jev -- --suite ja-v1 --max-attempts 60 --out results/jev-eval.json` (JEV_API_KEY 必須) | — |
| 7 | Discord live smoke | `bun run test:discord:live` — 未整備なら skip と明記 | — |
| 8 | deploy smoke | `GET /api/health` = 200 | — |
| 9 | public stats | `GET /api/stats` = `pending`/`ok`、payload が数値のみ | — |
| 10 | ops ログ | `logEvent` 行が JSON で、id/body/自由文を含まない | — |
| 11 | 削除確認 | close した room の tombstone=done・全データテーブル空 | — |
| 12 | 予算 cap | JEV/生成 cap が env に設定済み(未設定= fail-closed) | — |
| 13 | rollback 手順 | `wrangler rollback --env production` の事前確認 | — |

## メモ欄

- 対象 version / commit:
- 実施者 / 日時:
- 気付き・既知の残件: