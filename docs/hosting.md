# ゆらぐー！ ホスティング手順

マルチプレイ（へや）を自分の環境で動かすためのセットアップ・環境変数・
デプロイの要点。ローカル開発と本番 Cloudflare Workers デプロイの両方を
カバーする。ゲームルールは [game-rules.md](./game-rules.md)、招待秘密の
扱いは [privacy.md](./privacy.md)、WebSocket プロトコルは
[protocol.md](./protocol.md) を参照。

## ローカル開発

2 つのプロセスを並行して動かす。

```bash
# Web (Vite, http://127.0.0.1:5173)
bun --cwd=apps/web run dev

# API + GameRoom DO (wrangler dev, http://127.0.0.1:8787, APP_ENV=local)
bun --cwd=apps/server run dev
```

`apps/server run dev` は `wrangler dev --var APP_ENV:local` を実行する。
ローカルモードでは JEV のアップストリーム呼び出しに `JEV_API_KEY` と
`JEV_DAILY_ATTEMPT_CAP` が必須（未設定だと dev ルートが upstream への
送信を拒否する）。`.dev.vars` か `--var` で渡す。

フロントエンドから別オリジンの API を指す場合は `?api=<origin>` を
URL に付ける（例: `/?api=http%3A%2F%2F127.0.0.1%3A8787`）。E2E もこの
仕組みで wrangler dev を指している。同一オリジン配信（本番構成）では
省略で `/api` に届く。

## 環境変数

サーバ (`apps/server/src/config.ts` の `ServerBindings`):

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `APP_ENV` | `production` | `local` で dev ルートと upstream 呼び出しを有効化 |
| `ALLOWED_ORIGINS` | — | CORS を許可するオリジンのカンマ区切りリスト |
| `ROOM_HEARTBEAT_MS` | 15000 | クライアント heartbeat 間隔 |
| `ROOM_LEASE_MS` | 45000 | presence リース（切れると切断扱い） |
| `ROOM_EMPTY_GRACE_MS` | 60000 | 全員切断後の入室猶予（復帰可） |
| `ROOM_PURGE_DELAY_MS` | 5000 | 期限切れ mark から実削除までの猶予 |
| `ROOM_MAX_CONTENT_BYTES` | 8MiB | ルームの保存コンテンツ上限（開始時のみ検査） |
| `ROOM_MAX_GAMES` | 20 | 1ルームの完了ゲーム数上限 |
| `ROOM_MAX_LIFETIME_MS` | 12h | ルームの最大寿命 |
| `JEV_UPSTREAM_URL` | — | JEV 評価アップストリーム（dev/test 差し替え用） |
| `JEV_API_KEY` | — | local モードで upstream 送信に必須のキー |
| `JEV_DAILY_ATTEMPT_CAP` | — | 1日あたりの JEV 評価試行上限（正の整数） |
| `GENERATION_UPSTREAM_URL` | — | 選択肢生成の差し替え先（dev/test のみ） |
| `GENERATION_DAILY_ATTEMPTS` | — | 1日あたりの生成試行上限（正の整数） |

### Workers AI バインディング（本番のみ）

`env.production` の `ai` バインディング（`env.AI`）が本番の生成プロバイダ。
`wrangler dev` と vitest-pool-workers は Workers AI をローカル実行できない
ため、トップレベルには置いていない。ローカル・E2E は
`GENERATION_UPSTREAM_URL`（または mock プロバイダ）で代替する。

## デプロイ

```bash
cd apps/server
wrangler deploy --env production
```

`wrangler.jsonc` は Durable Object のマイグレーションを保持する:

- `v1`: `GameRoom`（SQLite バックドのルーム DO）
- `v2`: `CONTROL_PLANE`（デプロイ全域の予算/レジストリ DO）

どちらも `new_sqlite_classes`（`ctx.storage.sql`）で宣言する。
新しい DO クラスを足したら同じ形で migration tag を追加すること。
本番シークレットは `wrangler secret put` で設定し、`--env production`
デプロイ時に `env.AI` が自動でバインドされる。

## 招待 URL とフラグメント

招待リンクは `https://<host>/r/<roomId>#<inviteSecret>` の形。
`#` 以降（フラグメント）は HTTP リクエストに含まれずサーバへ送られない
ため、招待秘密がログや Referer に残らない。入室が完了した時点で
`history.replaceState` でフラグメントを消去する — 戻る操作やリロードで
secret が復活することはなく、コピーしたリンクにも名前等の個人パラメータは
載らない。ルール詳細は [privacy.md](./privacy.md)。

## ルームのライフサイクルと上限

- ルームは `POST /api/rooms` で作成、ホストは招待リンクを共有して参加を集める。
- コンテンツ 8MiB・完了 20 ゲーム・連続稼働 12 時間が既定の上限。
  上限検査はゲーム開始境界（startGame / rematch / createRoom）でのみ行い、
  進行中のゲームを止めたり既存コンテンツを切り詰めたりしない。
- 全員切断後 `ROOM_EMPTY_GRACE_MS`（既定 60 秒）以内なら再入室で復帰可能。
  猶予を過ぎると期限切れ mark → `ROOM_PURGE_DELAY_MS` 後に削除される。
- presence は heartbeat / lease で管理し、リース切れのクライアントは
  自動で切断扱いになる（ホスト転送のトリガ）。

## 関連ドキュメント

- [game-rules.md](./game-rules.md) — ルール定数・フェーズ遷移・投稿制約
- [privacy.md](./privacy.md) — 招待秘密・フラグメント取り扱いのルール
- [protocol.md](./protocol.md) — WebSocket プロトコル仕様
