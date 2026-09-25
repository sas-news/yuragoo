---
slug: yuragoo-development
status: plan-ready
intent: clear
review_required: false
pending-action: user selects separate worker execution or optional high-accuracy review
approach: 指示書の全7段階を生命体優先で実装する単一計画。招待制Web/Discord、TURN公平性、短期ルーム状態、匿名公開集計。
---

# Draft: yuragoo-development

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
| id | outcome | status | evidence |
| --- | --- | --- | --- |
| creature | 名のない半透明生命体の気持ちよい変形 | active | 指示書:215-450 |
| rules | 2〜6人、TURN/LIVE、公平な標準終了 | active | 指示書:452-625,954-1028; owner answers |
| ai | Jev判断、限定生成、日本語eval、費用制限 | active | 指示書:661-870,1218-1246 |
| rooms | 同期、復旧、ホスト引継ぎ、閉鎖削除 | active | 指示書:873-924; owner answers |
| experience | ロビー、編集、紙芝居 | active | 指示書:628-700,1031-1133 |
| platforms | 招待制WebとDiscord Activity | active | 指示書:107-140,1137-1181 |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
- 可逆な初期値: TURN3 rounds/20秒、LIVE120秒、early/host endはoff、Jev3秒/attempt＋最大1retry、settling8秒、reconnect grace60秒。全員不在時はplaying時計だけpause、settling hard deadlineは継続。
- 64点contour/固定substep、ReactはDOM・Pixiはframe描画、低負荷30fps、通常60fps、reduced motionは意味ある姿勢変化を残す。
- 公開集計は20完了試合以上から前日分までをglobal totalsとして表示。本文/個人/room別記録は公開しない。数値outboxはroom中のみretryしcloseで破棄、欠落を許容して本文削除を優先。
- GameRoomとは別のControlPlane DOが日次quota/短命mapping/匿名集計を担当。複数roomから同時に日次枠を超過しないため。

## Findings (cited - path:lines)
- 開始時、製品コード・package.json・testsなし。既存仕様書1537行のみ。既存 `.codegraph/` と `.omo/run-continuation/` は作業対象外。
- https://docs.typesafe.ai/models : jev-1.13.0、入力$0.042/Mtoken、英語以外は独自eval必要。実APIは未実行。
- https://docs.typesafe.ai/primitives/choice : choice/probabilities/confidence。confidenceは分布の偏りであり正解率ではない。
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ : hibernation時メモリ消失、deploy時切断。
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ : deleteAllはSQLite論理削除。PITRは過去30日を扱うため物理的即時消去を約束しない。
- https://docs.discord.com/developers/activities/development-guides/multiplayer-experience : instanceId共有、サーバーで本人/参加者確認。
- https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/ : @cf/qwen/qwen3-30b-a3b-fp8、入力$0.0509/M、出力$0.335/M。小型active-parameter多言語モデルを採用候補から確定。

## Decisions (with rationale)
- intent=clear、review_required=false。高精度二重レビューは未指定。通常Metisギャップ分析は実施済み（session ses_f46d5f925ffejv84p1y5vxFHS5）。
- ユーザー承認: 全7段階・6領域・1計画、公平性優先、TDD＋描画検証、招待制。
- AI: TypeSafe直接＋Workers AI、Jev最大120試行/game、生成は前後各1試行、日次制限設定必須。
- 保存: 24h履歴案はユーザーが却下。ルーム中のみ全文を保持し、個人/本文に結びつかない簡単な公開集計を残す。
- ホスト不在: ユーザーは自動引継ぎを選択。全員不在60秒で終了。接続中参加者への引継ぎと全員不在時の停止・削除を分離。
- 採用しないレビュー提案: 全投稿到着ごとに古いevalを破棄する設計（飢餓）、confidence低値のエラー化、上限121回目の送信、古いAIでhost-decide勝者生成、通常CIだけでDiscord完了扱い。
- テンプレート生成は親にshellがないためユーザーが指定scaffoldを実行。生成した2ファイルをReadで確認済み。製品コード変更なし。
- 計画は7waves・39 implementation rows・4 final verifier rows。初回構造検査: explore session ses_f46c5b130ffex34AlFU5kJ6TqY、read-only PowerShell parserで数とDAGを確認。指摘のoutbox寿命/settling時計/final verifier欄を修正、Task8をTask7のschema依存へ変更。
- 最終構造検査: 同sessionのread-only再検査PASS。39 implementation＋F1–F4、7waves、全taskの参照/合格条件/happy/failure/証跡/commit、matrix一致、cycleなし、placeholderなし。親もgrepで43task rows/4final rows/8所定見出しを独立確認。
- 完成plan `.omo/plans/yuragoo-development.md`。このセッションが編集したファイルはdraft/planのみ。通常Metis＋構造自己検査は実施済み、高精度Momus/Oracle二重レビューは未実施。

## Scope IN
- 完全な7段階、試合設定、補助生成、紙芝居、DiscordとWeb、復旧/削除/費用制限、匿名集計、テストと運用資料。

## Scope OUT (Must NOT have)
- 個人ランキング、履歴サービス、アカウント基盤、課金、Steam、VC、自動文章生成をゲーム中に実行、7人以上、公開マッチング。

## Open questions
- 製品方針の未決事項なし。秘密鍵・実Discordテスト環境がない場合は該当実接続ゲートをBLOCKEDとし、モック成功で代替完了しない。

## Approval gate
status: approved
approval: 方針説明後のユーザー「ok」。計画作成のみ承認、実装は別worker。
next: ユーザーに完成計画を渡し、別workerでの実装または高精度レビューの選択を待つ。承認を実装開始に読み替えない。
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
