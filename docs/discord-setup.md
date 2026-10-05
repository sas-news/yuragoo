# Discord セットアップ（Task 36）

ゆらぐー！は Discord アクティビティとしても動く。Web本体は同一 Worker が配信し、Discord は `/` と `/api` をこの Worker にマップする。

> 2026-09-27 時点: staging は **https://yuragoo-staging.sasshinbun0655.workers.dev** にデプロイ済み（secrets/vars 設定・AI binding 済み）。実機テストは URL Mappings の / を yuragoo-staging.sasshinbun0655.workers.dev に向けるだけでよい — quick tunnel は不要になった。コード更新は bun run deploy:staging。

## 前提

- Discord Developer Portal でアプリケーションを作成し、**Activities を有効化**（Embedded App SDK v2 以降を利用）。
- `VITE_DISCORD_CLIENT_ID` に Application ID を入れて `bun run build`（web）する。クライアントIDは秘密情報ではない（Activity URL にも載る）。
- Worker 側の secret は `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`（`wrangler secret put`）。OAuth code exchange は `/api/discord/token` が行う。

## URL マッピング（Developer Portal → Activity → URL Mappings）

| マッピング | 宛先 |
| --- | --- |
| `/api` | 本番は `yuragoo.sasnews.dev`（custom domain）。staging 検証時は `yuragoo-staging.sasshinbun0655.workers.dev` |
| `/` | 同上（longest-match で `/api` が先に効く） |

**宛先はスキームを書かない** — Discord の URL マッピングは `https://` を付けず
`host` だけ入れるフォーマット（公式 local-development.mdx）。プロトコルは
マッピング側が選ぶので wss もここで拾える。

WS は同一 origin の `/api/rooms/:id/ws` に乗る — プロキシ側で `/api` を剥がさない（パスごと転送）。patchUrlMappings は不要。Discord proxy は WebSocket を通す（WebTransport は未対応）。

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

## ローカルでの実機検証（Task 37 入口）

Discord アクティビティは `localhost` を直接は指せない — iframe が読み込むのは
`<app-id>.discordsays.com`（Discord のプロキシ）で、URL マッピングの宛先には
**公開 HTTPS のオリジン**が必要。ローカル実機検証は Cloudflare クイックトンネルで
wrangler dev を公開する（公式チュートリアルと同じ構成）。

1. web をビルド: `VITE_DISCORD_CLIENT_ID=<app id> bun --cwd=apps/web run build`
2. worker を assets 付きで起動: `bunx wrangler dev --config apps/server/wrangler.jsonc --env e2e --port 8790 --compatibility-date 2026-08-22`
   （env.e2e は assets binding だけを持つローカル専用 env。top-level の compat date は
   ローカル workerd が非対応のため上書きする）
3. トンネル: `cloudflared tunnel --url http://127.0.0.1:8790` → 表示された
   `https://<random>.trycloudflare.com` を使う
4. Developer Portal の URL Mappings で `/` をそのトンネル URL に設定
   （`/api` へのAPI要求は `/` の longest-match が拾うので別マッピングは不要。
   WS は `/api/rooms/:id/ws` に乗り、trycloudflare→wrangler→Discord proxy の
   二重プロキシで成立する）
5. OAuth2 → Redirects に `https://127.0.0.1` を登録（公式チュートリアルの
   プレースホルダ。SDK が redirect を内部で処理するので実値は何でもよいが
   1件以上ないと authorize が弾かれる）
6. インストール: Installation → Installation Contexts で **User Install / Guild
   Install 両方をON**（非配布アプリでもVC内の App Launcher に出るために必要）
7. Discord クライアント: ユーザー設定 → 詳細設定 → 開発者モード ON →
   VC参加 → ロケットアイコン or App Launcher でアプリ名を検索

### シェルフに出ないときの条件（local-development.mdx より）

- **Enable Activities がON**（Activities → Settings の一番上のチェック）
- **Supported Platforms に今使ってるプラットフォームをチェック**
  （Activities → Settings。web/desktop で見るならそれを入れないと出ない）
- Developer Mode ON のアカウントで、そのアプリを所有 or チーム所属
- VCに参加していること（参加前はシェルフに出ない）

トンネル URL は起動ごとに変わる。固定 URL が欲しくなったら quick tunnel ではなく
staging deploy（`bun run deploy:staging`）を使う — URL マッピングを安定させられる。

`?platform=discord` 付き localhost は「gate の外観だけ」の擬似シェルで、
SDK が無いので authorize で必ず失敗する。実機確認には使えない。

## うまくいかないとき

- `denied` / `invalid-command`：クライアント側の consent 拒否 or 古い Discord クライアント。`classifyDiscordError` が UI コピーを返す。
- `/api` が HTML で返る：`run_worker_first` の効きを疑う（`/api/health` が JSON 200 か確認）。
- WS が 101 にならない：ticket 発行（`/api/rooms/:id/ticket`）が成功しているか。upgrade ヘッダはワーカー内部の DO が消費する。
