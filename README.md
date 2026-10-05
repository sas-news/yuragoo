# ゆらぐー！

**https://yuragoo.sasnews.dev** で公開中 — Discord なしでもブラウザだけで遊べる
（Discord Activity は同じルームへの別入口）。

なまえのない生命体を、みんなのひとことで引っ張るパーティーゲーム。
Bun workspaces の monorepo。ブラウザ版が主戦場で、Discord Activity は
adapter 経由で同じルームに乗る。

```text
apps/web       React/Vite クライアント(ロビー・アリーナ・結果)
apps/server    Cloudflare Worker + GameRoom/ControlPlane Durable Objects
packages/      game-core / protocol / creature / ai / platform
tests/         unit / workers (workerd) / e2e (playwright) / jev-evals
```

## セットアップ

```bash
bun install
```

## ローカル開発(mock と live)

```bash
bun --cwd=apps/web run dev       # http://127.0.0.1:5173
bun --cwd=apps/server run dev    # wrangler dev, :8787, APP_ENV=local
```

`APP_ENV=local` では生成は mock プロバイダ(ネットワーク不要)か
`GENERATION_UPSTREAM_URL` の fixture へ向く。Jev 評価だけ upstream が
要り、`JEV_API_KEY` + `JEV_DAILY_ATTEMPT_CAP` を `.dev.vars` か `--var`
で渡す。本番(production)は Workers AI binding と実エンドポイント。

ブラウザから別オリジンの API を指すときは `?api=<origin>` を付ける。

## チェック

```bash
bun run check          # biome + tsc + boundary/LOC チェック
bun run test:unit      # bun test tests/unit
bun run test:workers   # vitest + workerd(DO/SQLite 実体)
bun run test:e2e       # playwright(自前で wrangler dev + vite preview)
```

既定 CI(`.github/workflows/ci.yml`)はこの順に全部回す。
live 系(`eval:jev`・Discord live)は secrets が要るので既定 CI には
入れず、`live-gates.yml` を手動 dispatch する。

## デプロイ / ロールバック / 削除 / 上限

- 手順全体: [docs/operations.md](docs/operations.md)
- デプロイ前の確認表: [docs/release-checklist.md](docs/release-checklist.md)
- 招待 secret・集計・削除の約束: [docs/privacy.md](docs/privacy.md)
- 環境変数の一覧: [docs/hosting.md](docs/hosting.md)

要点だけ: `bun run deploy:staging` で検証用 worker、
`bun run deploy:production` で本番へ(worker が SPA を same-origin 配信)。
戻すときは `wrangler rollback --config apps/server/wrangler.jsonc --env production`。
ルームは close/empty/lifetime のどれでも `deleteAll()` で消え、
匿名の合計値(20ゲーム以上から公開)だけが残る。