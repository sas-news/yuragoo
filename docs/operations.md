# 運用 runbook

ゆらぐー！のデプロイ・環境変数・日次予算・ルーム削除・ロールバックの
要点。セットアップ手順は [hosting.md](./hosting.md)、削除の仕様は
[privacy.md](./privacy.md) を参照。

## デプロイ

```bash
bun run deploy:staging       # staging (yuragoo-staging)
bun run deploy:production    # production (yuragoo-server)
```

どちらも `bun run build`(apps/web の dist 生成)から始まり、worker が
Workers Static Assets で SPA を same-origin 配信する。

- DO migration は `wrangler.jsonc` の `migrations` に追いつく。
  新しい DO class を足したら `new_sqlite_classes` の tag を追加すること。
- デプロイ後の smoke: `GET /api/health` が 200、
  `GET /api/stats` が `{status:"pending"|"ok"}` を返すこと。

## 環境変数・bindings

一覧は [hosting.md](./hosting.md) の表どおり。運用で触るのは主に:

- `JEV_API_KEY` — `wrangler secret put JEV_API_KEY --env production`。
  未設定では Jev 評価は fail-closed(投稿は pending のまま settle)。
- `JEV_DAILY_ATTEMPT_CAP` / `GENERATION_DAILY_ATTEMPTS` — 下の予算節。
- `ALLOWED_ORIGINS` — CORS 許可オリジン。same-origin 配信では不要。

binding は `GAME_ROOM` / `CONTROL_PLANE`(DO)、`AI`・`ASSETS`
(staging/production のみ)。`AI` を top-level に置くと `wrangler dev` と
vitest-pool-workers が課金 proxy セッションを開くので env 配下のみ。

## 日次予算

ControlPlane が UTC 日バケットで予約/消費を数える。

| 予算 | env | 単位 |
| --- | --- | --- |
| Jev 評価 | `JEV_DAILY_ATTEMPT_CAP` | attempt/日(送信済み消費) |
| 生成(選択肢+エンディング) | `GENERATION_DAILY_ATTEMPTS` | attempt/日 |

cap 到達時の挙動: Jev は post が pending のまま settle(noContest 側へ)、
生成は "generation-spent/denied" で静かに落ちる(テンプレのまま続行)。
ゲームは止まらない。送信用 grant はクラッシュ後も消費扱い — 使いすぎ
より二重送信を避ける設計。

## ルームのライフサイクルと削除

- 作成: `POST /api/rooms` → invite URL の fragment に secret。
- 生存上限: 12h・20ゲーム・8MiB(開始境界で検査)。
- 全員切断 → `ROOM_EMPTY_GRACE_MS` 猶予 → expiry mark → 
  `ROOM_PURGE_DELAY_MS` 後に `ctx.storage.deleteAll()`。
- 明示的 `closeRoom` も同じ retire 経路。残るのは tombstone 行だけ
  (room registry は同じ roomId を再発行しない)。
- Cloudflare PITR バックアップからの物理削除は約束しない(privacy.md)。

## ops ログ

`apps/server/src/observability.ts` の `logEvent` が出す JSON 1行だけ。
フィールドは `eventCode`/`modelVersion`/`latencyBucket`/`errorKind`/
`usage` のみ — body・room id・player id・query・自由文は出ない。
latency は `<1s`/`1-3s`/`3-10s`/`>10s` のバケットで生 ms は出ない。

## ロールバック

```bash
wrangler rollback --config apps/server/wrangler.jsonc --env production
```

直前の deployed version に戻る(SPA assets も version ごと戻る)。

- staging での先戻し検証: `--env staging` で同じコマンド。
- DO storage の schema は append-only を前提にする。戻した version が
  読めない行を書いていると復旧コストが跳ぶ — 破壊的 migration は
  リリースチェックリストで必須確認。