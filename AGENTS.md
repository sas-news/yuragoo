# AGENTS

このリポジトリで作業するエージェント向けの入口。

## 読む順番

1. `README.md` — 構成・セットアップ・コマンド
2. `.omo/HANDOFF.md` — セッション間引継ぎ。最新状態・設計規約・過去に踏んだ罠が全部ここ
3. `docs/` — operations / release-checklist / privacy / hosting
4. `.omo/plans/yuragoo-development.md` — 全体計画書（checkboxは信用せず実コードと照合）

作業で状態や規約を変えたら `.omo/HANDOFF.md` に追記して終わるのがこのリポの規約。

## 検証

```bash
bun run check          # biome + tsc + boundary/LOC + i18n辞書 — コミット前に必ず
bun run test:unit
bun run test:workers   # vitest + workerd(DO/SQLite実体)
bun run test:e2e       # playwright(自前で wrangler dev + vite preview)
```

## このリポ特有の罠（詳細は HANDOFF 参照）

- **手書きソース250行上限**（`scripts/check-boundaries.ts`）。末尾改行を1行余計に数えるので実質249行。超えたら分割する
- **GameSettings系フィールドを足したら `packages/protocol/src/snapshot.ts` の `resolvedSettingsSchema`(strictObject) にも足す**。忘れると再生中フレームが検証落ちして再接続が死ぬ
- **共有テキストは部屋言語(`RoomLanguage`)に従う**、個人UIロケールには従わない。シナリオ/選択肢/結末は全員同じものを見る
- UI文言は日本語原文キーの `t("…")`。新規キーを足したら `bun scripts/extract-i18n-keys.mjs --write` → EN辞書に訳を追加（missing>0でcheckが落ちる）
- wire境界は strict Zod。クライアントの identity claim は信用しない（attachment が唯一の身元）
- secrets は `.dev.vars` / wrangler secret。ログに出さない、コミットしない

## 既知の flake

- `tests/workers/room-restart.test.ts` の happy-path が環境によってタイムアウトすることがある（masterでも再現する既存件。回帰と誤認しないこと）
