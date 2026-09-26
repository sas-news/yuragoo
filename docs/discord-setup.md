# Discord セットアップ（Task 36）

ゆらぐー！は Discord アクティビティとしても動く。Web本体は同一 Worker が配信し、Discord は `/` と `/api` をこの Worker にマップする。

## 前提

- Discord Developer Portal でアプリケーションを作成し、**Activities を有効化**（Embedded App SDK v2 以降を利用）。
- `VITE_DISCORD_CLIENT_ID` に Application ID を入れて `bun run build`（web）する。クライアントIDは秘密情報ではない（Activity URL にも載る）。
- Worker 側の secret は `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`（`wrangler secret put`）。OAuth code exchange は `/api/discord/token` が行う。

## URL マッピング（Developer Portal → Activity → URL Mappings）

| マッピング | 宛先 |
| --- | --- |
| `/api` | Worker のオリジン（例 `yuragoo-server.<sub>.workers.dev`） |
| `/` | 同上（longest-match で `/api` が先に効く） |

WS は同一 origin の `/api/rooms/:id/ws` に乗る — プロキシ側で `/api` を剥がさない（パスごと転送）。patchUrlMappings は不要。

## 認証フロー（アクティビティ内）

1. `?platform=discord`（または Discord が注入する `frame_id` クエリ）で `DiscordGate` が起動
2. `sdk.ready()` → `commands.authorize({ scope: ["identify"], prompt: "none" })`
3. 返った `code` を `/api/discord/token` に POST → `{ access_token }`
4. `commands.authenticate({ access_token })` で SDK セッション確立
5. `/api/rooms/discord/join { instanceId, accessToken }` で instance 専用の部屋へ join（鯖側で user 検証・同一 user は同一 seat）

## 招待

- アクティビティ内では `commands.shareLink`（custom_id に instance 情報）。フォールバックは `openInviteDialog`。URL コピーは使わない。
- Web 版は従来どおり `/r/<roomId>#<inviteSecret>` のフラグメント招待。

## 環境

- `apps/server/wrangler.jsonc`: `env.staging` / `env.production` に assets（`../web/dist`）と `run_worker_first: ["/api/*"]` を定義。`bun run deploy:staging` → `wrangler deploy --env staging`。
- `env.e2e` はローカルの assets 付き検証用（`tests/e2e/discord/proxy.spec.ts` が `apps/web/dist` を伴って wrangler dev を立てる）。
- staging の secret/環境が揃っていない場合、deploy は **BLOCKED**（本番への代替 deploy 禁止）。

## うまくいかないとき

- `denied` / `invalid-command`：クライアント側の consent 拒否 or 古い Discord クライアント。`classifyDiscordError` が UI コピーを返す。
- `/api` が HTML で返る：`run_worker_first` の効きを疑う（`/api/health` が JSON 200 か確認）。
- WS が 101 にならない：ticket 発行（`/api/rooms/:id/ticket`）が成功しているか。upgrade ヘッダはワーカー内部の DO が消費する。

