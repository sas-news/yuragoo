# F4 — Scope fidelity

- 実施: 2026-10-04T13:18Z / commit `8a3d262`（最終リリース `9753501` — e2e旧契約追従+PipLobby属性追加のみ、ゲート結論不変）
- 判定基準: 禁止機能・無断保存・無関係変更 0、承認 scope 欠落 0

## 禁止機能の不在（負例チェックリスト → 実経路で確認）

| 禁止 | 確認結果 |
|---|---|
| 通常LLMナレーション | 生成物は選択肢/シナリオ/エンディングの構造化パースのみ。本文自由生成は UI に露出しない |
| 画像生成 | AI 呼出は `@cf/qwen/qwen3-30b-a3b-fp8`（テキスト）+ JEV 評価のみ。画像 API なし |
| 生きものの命名 | UI・イベント・DB のいずれにも名付け入力なし。「なまえのない生命体」表記のまま |
| ランキング/成績履歴 | leaderboard 系 route・UI・集計フィールドなし（`/api/stats` は合算数値のみ） |
| 長期履歴/アーカイブ | `browser.ts` routes: rooms/join/reconnect/ticket/stats/ws のみ。履歴取得 endpoint なし。close で `ctx.storage.deleteAll()` |
| 公開マッチメイキング | ルームは招待 URL fragment secret 経由のみ。room 一覧・検索 API なし |
| アカウント/課金/ボイス | 該当コード・依存なし（確認済み） |

## dev 経路の prod 非露出

- `apps/web/dist` prod bundle に `dev/showcase|dev/creature|dev/decision|dev/game` の文字列なし（devEnabled dead-code 除去確認）
- サーバー `createApp` は `APP_ENV=production` で `createProductionApp`（`/api/health` のみ）。`/api/dev/*` は local mode + loopback 限定
- mock/generation upstream は `GENERATION_UPSTREAM_URL` が無い限り `env.AI` binding のみ — prod は Workers AI が必ず応答、mock の live 詐称なし

## 保存データ inventory（無断保存なし）

- room 寿命中: 投稿・events・roster・ハッシュ化トークン（平文 secret 保存なし）・AI job・outbox
- close 後: tombstone のみ（ユーザーデータ不含）+ ControlPlane 匿名集計数値 + 短命 receipt（7日物理削除）
- クライアント: localStorage=表示名のみ / sessionStorage=同タブ再接続トークン / Cookie なし
- ops ログ: `logEvent` allowlist（eventCode/modelVersion/latencyBucket/errorKind/usage）— ID・本文・query 不在を型で保証。低リスク残件: `rooms/due.ts` の失敗時 `console.log` が `e.message` を出力（固定タグ+内部エラー文、ユーザー文字列は含まれ得ない経路）

## プライバシー遵守

- 招待/session token は URL fragment・body のみ、サーバー保存はハッシュ
- `/api/stats`: 合算数値のみ・20件未満 pending・前日UTCまでのバケット
- `/privacy` `/terms` 公開ページを同梱（本 commit で追加）

## 判定: APPROVE
