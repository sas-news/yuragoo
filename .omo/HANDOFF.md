# ゆらぐー！ 引継ぎ（2026-09-26）

このファイルはセッション間の引継ぎ。最新の状態をここに集約する。
計画書: `.omo/plans/yuragoo-development.md`（todosは実ファイル・テスト存在と照合すること — checkboxは未更新のまま）

## 現在地

**W1〜W6（Task 1〜33）完了。W7は Task 34・35・36・38 が完了**、残りは Task 37（実Discord QA・資格情報でBLOCKED）、live Jev eval receipt（JEV_API_KEY）、F1〜F4最終検証。Task 39のゲート一式は実装済み（tests/workers/release-chaos.test.ts 4件・tests/e2e/release/ 2件・manifest .omo/evidence/task-39-release-manifest.json）。

### Task 37 進行中（2026-09-27）

Discord 資格情報は apps/server/.dev.vars に配置済み（DISCORD_CLIENT_ID=1553394215029968926 / SECRET / ORIGINS=https://1553394215029968926.discordsays.com）。実機ローカル検証ルート確立: **localhost は URL マッピングの宛先にできない**（iframe は <app-id>.discordsays.com 経由でしかロードされず、Discord は公開 HTTPS のオリジンしか辿れない）。cloudflared quick tunnel で wrangler dev(--env e2e, assets付き) を公開し、Portal の URL Mappings 「/」 をトンネル URL に向ける。検証済み: トンネル経由で / → SPA HTML・/api/health → JSON・/api/discord/token → discordsays origin 許可 / evil origin 403 / bogus code で discord-auth 403（実Discord APIまで往復）。詳細手順は docs/discord-setup.md「ローカルでの実機検証」。残るは Portal 設定（Activities有効化 / URL Mappings / OAuth2 redirect https://<app-id>.discordsays.com/）と Discord クライアントでの起動。

### 紙芝居エンディング（Task 29〜33）の実装メモ

- 契約: packages/protocol/src/story.ts — panel={kind,eventId=events.seq,postIds,quotes,pull,title,caption}、generatedフラグ。endingReady は wire.ts ROOM_FRAME_TYPES + sync.ts ORDERED + room-sync.test.ts の3箇所登録済み。snapshot.ending でresync heal
- 抽出: packages/game-core/src/story/ — buildStory が start/reversal/impact/endgame/result を決定的選択（同点はseq早い方、group coverage=(prevRevision,revision]全投稿をquotes化）
- 姿勢再現: panel.pull=roster slot順の生確率 → クライアント側 canonicalPose（PULL_GAIN=3、random.next()=0.5固定で決定的）でSVG描画。bitmapはサーバーへ送らない
- 生成: 'post' slot（ControlPlane reserve/consume、10s deadline、all-or-nothing。失敗時template維持・イベントなし）。settle の waitUntil → driveEnding() lane が自動でtemplate→生成を駆動
- UI: apps/web/src/results/{Results,Kamishibai,Panel}.tsx — 全員同一panel集合、各自ページ送り、backToLobby=rematch準備、closeRoom=host専用＋確認
- 契約書: docs/story-contract.md

### W6で踏んだ罠（再発防止）

- room-outcome testid が旧結果ダイアログと共に消えて full-flow.spec の playMatch が死んだ — testid削除時は参照側を必ず rg。playMatch は room-results/results-outcome 参照に修正済み（outcome copyは /勝ち|ひきわけ|むこう/）
- lobbyのchoice行数はメンバー数と一致（ensureChoiceRowsがjoin毎に行を生やす）。arm系ヘルパーは DOM の実在行を読んでから updateLobbyContent — 2人部屋に4ラベルは渡せない
- injectDecisionJobDeps のキーは fetch（upstreamFetchではない）。apiKey も非空で渡すこと（空ならfail-closedでjob全滅）
- gameEpoch は room_meta に住む — backToLobby で room_meta ごと消えるので新gameは epoch=1 に戻り得る。「新しいgame」はepoch値ではなく内容（quotes/title）で判別する
- gen fixture の requests は累積カウンタ — spec内他テストのsendも数える。baseline差分で断言する
- RoomGame が unmount される間 feed 行は DOM に存在しない（view.feed は保持される）。lobby中の feed assert は不可
- ページ送りは各クライアントのローカルstate — DOM収集前に必ず page1 へ正規化すること

**W1〜W5の詳細（引き続き有効）:**
- 生命体描画・変形・引力、Jev sandbox、ローカル対戦（/play）
- 同期ルーム：WS再接続・ホスト引継ぎ・自動選出・サーバー再起動復旧・空猶予60s
- ロビー編集（シナリオ/選択肢）、Workers AI選択肢生成、設定、準備/開始
- quota: ControlPlane原子予約、Jev 120枠/試合（通常118+settling2）、生成2枠/試合
- 削除：closeRoom→mapping revoke→epoch無効化→deleteAll、expired purge、outbox retry
- アクセシビリティ・full-flow e2e gate通過済み

**ユーザーが「めちゃくちゃいい」と承認した直近の修正（詳細は下記）:**
- ルーム画面で生きものが傾くようになった（重大バグ修正）
- ▼ターンマーカー大型化・上位置、座席アイコンの端固定、下トレイのフラット化＋時間バー移動、ロスター右寄せ

## W6完了済み（Task 29〜33）：紙芝居エンディング

計画書 `.omo/plans/yuragoo-development.md` の Task 29〜33 は実装・テスト・検証まで完了済み。以下は当時のタスクメモ（実ファイル・テストは全て存在する）:

依存DAG: 28(済) → {29, 30, 31} 並行可 → 32 → 33

- **Task 29** `packages/game-core/src/story/{highlights,panels,templates}.ts`: 試合ログから開始/最大逆転/最大impact/終盤/結果をeventId参照で決定的抽出（3〜5panel、不足時3まで削減）。single/group保持、同点はseq早い方。全ログを生成providerに渡さない。`tests/unit/story/highlights.test.ts`
- **Task 30** `packages/creature/src/{snapshot,replay-pose,extract}.ts`: server decision+seedからcanonical pose再構成、extract.canvasでBlob化（eventId最大5枚保持、results破棄時release、画像はサーバーへ送らない）。`tests/e2e/story/snapshots.spec.ts`
- **Task 31** `packages/ai/src/ending-generation.ts` + `apps/server/src/rooms/generate-ending.ts`: 構造化eventsのみ→G1生成、title<=40/caption<=80 grapheme、eventId allowlist parse、失敗/遅着はtemplateへ一度だけfallback。`tests/workers/ending-generation.test.ts`
- **Task 32** `apps/web/src/results/{Results,Kamishibai,Panel}.tsx` + `apps/server/src/rooms/ending.ts`: 全員同一panel集合、各自ページ送り、rematch準備、closeRoom確認。download/share機能は作らない。現在の簡易結果ダイアログ（`RoomGame.tsx`内の「結果」ボタン周辺）を置き換える
- **Task 33** Phase6 gate: `tests/e2e/story/full-ending.spec.ts` + `tests/workers/story-lifecycle.test.ts` + `docs/story-contract.md` — 人間投稿が主役・本文保存終了・生成call<=2/試合を検証

### W7完了分のメモ（Task 34/35/36/38）

- 34: packages/platform/src/{discord,discord-errors,discord-layout}.ts SDK注入IF + apps/web/src/platform/{bootstrap,DiscordGate}.tsx。platform=discord/frame_idでgate分岐、browser経路はSDKをlazy-loadしない
- 35: POST /api/discord/token（code交換）+ POST /api/rooms/discord/join（instanceId+accessToken→verified seat）。room_players.discord_user_id partial unique indexでseat dedupe、再joinはhash回転。instance→roomは idFromName(discord:+instanceId)、room_authはcommitJoin内でlazy作成。DISCORD_ORIGINSは .discordsays.com 形式のsuffix許可
- 36: wrangler env.production/staging/e2eにassets(../web/dist)+run_worker_first:[/api/*]+SPA fallback。apps/web/src/net/urls.tsにapiOrigin/apiUrl/wsUrl/inviteUrl/roomPath集約。deploy:staging/deploy:production scripts
- 38: とうけいリンク→/api/statsダイアログ（20件未満pending）、observability.ts（codes/bucket/usageのみ、本文・ID・query一切なし）、.github/workflows/{ci,live-gates}.yml、docs/{operations,release-checklist}.md、README、privacy.md追記

### W7の罠

- wranglerのenvブロックは durable_objects/migrations を継承しない — envだけ足すとDO bindingが消え /api/rooms がconfig 503。全envに明示（e05764c）
- adapter.specのhappyはマウント済みDiscordGateの自動bootと混線する — join成功でnavigateすると__fakeLogが2周する。joinを失敗stub＋gate boot完了待ち＋計測直前リセットで分離（a48f546）
## 次にやること — W7（Task 34〜39）Discord+リリース
- 34 platform adapter（`packages/platform/src/` は adapter.ts/browser.ts のスタブのみ）
- 35 Discord OAuth/メンバーシップ認可
- 36 Workers Static Assets配信+proxy経路（`docs/discord-setup.md`）
- 37 実Discord QA — **許可済みアカウント/開発ActivityがなければBLOCKED**（事前認証profile必須）
- 38 公開匿名集計（`/api/stats` route、20件未満pending、日次UTC更新）+ ops/privacy/release-checklist docs + CI workflow。`apps/server/src/control/{aggregates,receipts}.ts` の基盤は済み
- 39 release gate（10rooms×6clients負荷、全suite、manifest）
- 最後に F1〜F4 最終検証（compliance/quality/manual QA/scope）

## 今回セッションの重大バグ修正（再発防止の知見）

### 症状: 「生きものがかたよりました」が出るのに生きものが真ん中に戻る

**原因は3層に分かれていた**:

1. **`committedCount` がプレイ中ずっと0**（本命）— `room-arena.ts` が `view.state?.settings.rosterSize ?? view.lobby.committedCount` を参照していたが、`view.state` はスナップショット経由でしか入らず、`lobbyChanged` も開始コミットを運ばない → `committedChoices` = `slice(0,0)` = 空 → distのchoiceId検索が全滅 → 全weightがuniform fallback → 永久に中央固定。**ルームの傾きは実装以来一度も出ていなかった**。修正: `view.roster.length > 0 ? view.roster.length : view.lobby.committedCount`（rosterは"started"イベントで折られる＝コミット数と一致）
2. **評価待ちのギャップ** — 投稿→950msフリッカー終了→Jev応答（1〜3s）までベースがuniformに戻る。修正: `usePostReaction` が pending中は保持（最小950ms/最大6s）、evaluated/failed到着で解放
3. **分布が穏やかすぎ** — 実Jevは0.45/0.30程度を返す。修正: `roomSamples`でweight³（`PULL_GAIN=3`）して正規化（順位・同点保存）

### 教訓
- **feed行の出現はデータ到達の証明にならない**。`decisionUpdated`の実frameをwsLogで掴み、`__roomView`一時露出（今は撤去済み）でview.dists/posts/committedCountを直接読んで特定した
- デバッグ用一時計装は（a）ブラウザ側`window.__*`露出、（b）`[tag]`付きconsole.logをwranglerログから`Select-String`で抽出、の2系統が有効だった。終わったら必ず撤去する
- `scripts/probe-dist.ts`（fold→samples単体分離）と`scripts/cap-lean-hold.ts`（実ブラウザstatus chainポーリング、PASS/CHECK verdict）が再現検証ツールとして残っている

## 直前まで直していた他バグ（全て修正済み・検証済み）

- **パスで時計が狂う**: 手動passが`nowMs=state.deadlineAtMs`（スケジュール時刻）を注入→早パス毎にゲーム内時計が+20s先行→settle deadlineが遠未来→アラーム来ず→リース切れ→purge→`not-created`。修正: `pass`アクション新設し実時刻で進行（`packages/game-core/src/turn.ts`の`passTurn`）
- **アラーム飢餓**: 全コマンドの`waitUntil(rearm())`が無条件`setAlarm`→実行中ハンドラをキャンセル→ゲーム時計が発火しない。修正: `rearm()`は既存アラームより早める場合のみ`setAlarm`
- **`lobbyReopened`がクライアントで捨てられる**: `sync.ts`の`ORDERED`集合に未登録→foldに届かずロビー復帰しない。1行追加＋`room-sync`回帰テスト
- **ターン順ローテーション→固定順**: ユーザー要望で`orderForRound`を単純繰り返し（ABAB）に変更、`prevTurnPlayerId`廃止
- **UI**: 「★にする」→「ホストにする」、結果ダイアログのボタン並び、シナリオ全文展開`ScenarioStrip`、名前localStorage保存、エラー行オーバーレイ化、座席プレート撤去＋大アイコン＋名前ピル

## 検証コマンド

```
bun run check          # biome + 全tsconfig + 境界/LOC（299ファイル）
bun run test:unit      # 142 tests
bun run test:workers   # 100 tests（vitest-pool-workers、例外ログはnegative-path想定出力）
bun run test:e2e -- tests/e2e/<file>   # playwright
bun run eval:jev -- --suite ja-v1 --max-attempts 60   # live Jev（JEV_API_KEY必要）
```

## 開発環境

- フロント dev: `bun --cwd=apps/web run dev` → http://127.0.0.1:5173
- Worker dev: `bun --cwd=apps/server run dev` → http://127.0.0.1:8790（wrangler `--compatibility-date 2026-09-18`。stale workerdが残ったままだとポートは開くが応答しない → `taskkill /F /T /PID <親>`でツリーごと整理して再起動）
- ルームURL: `/r/<roomId>?api=<API origin>&name=<表示名>#<inviteSecret>`
- `?hb=<ms>` でハートビート間隔を縮められる（再現高速化）
- ユーザーの環境では8787=旧vite+8790=workerの併用が多い。挙動が古い場合はdev server再起動を促す

## 再現・診断スクリプト（`scripts/`）

- `cap-lean-hold.ts` — 投稿→status chainポーリング（「かんがえている」→「のほうへ」遷移＆「おちついている」非経由を検証、verdict PASS/CHECK）
- `cap-room-visual.ts` — ルーム画面の1280/375pxスクリーンショット（傾き・▼・座席・バー確認用）
- `probe-dist.ts` — fold→latestRoomDist→roomSamplesを単体で追跡
- `cap-backtolobby.ts` — 完走→結果→ロビー復帰
- `cap-jev-dist.ts`/`cap-jev-live.ts` — decisionUpdated実payload取得
- `cap-turn-stall.ts`/`cap-room-crash.ts` — 時計・消失系の再現
- 使い方: `REPRO_API=http://127.0.0.1:8790 bun scripts/<name>.ts`（room作成はスクリプト内で実施）

## コード上の注意

- `POST /api/dev/jev/evaluate` はdev専用gateway。`JEV_API_KEY`は`.dev.vars`（設定済み）
- `decisionUpdated`は実Jev結果でのみ発行。failedは`decisionFailed`（foldでpostを"evaluated"扱いにして保持解放、distは無い）
- `room-view.ts`のfoldは全イベントをORDERED経路で処理。`sync.ts`の`ORDERED`集合が受信可否を決める — **新しいserver eventを足したら必ずORDEREDに登録**
- `roomSamples`のchoiceId照合は`committedChoices`（slice）経由 — 選択肢数とcountの不整合が全滅する落とし穴だったので変更時は注意
- `usePostReaction`の解放タイマーはref管理（effect cleanupだとpending→evaluatedの再実行で殺される）
- LOC上限250行/file（check-boundaries）。例外ログ・コメント行も数える
- noUncheckedIndexedAccess: `arr[i]`は`T|undefined` — `?? fallback`を忘れない

## ユーザーの好み・進め方

- 日本語で会話。UI copyはひらがな寄りの柔らかい日本語（「かたよりました」「ぐーんとのびている」等）
- 「いきなりDiscord multiplayerを作らない」「テストしたほうがいい領域まで来たら止めて」— 生命体の手触り優先、手動確認が必要な見た目/感触はユーザーに確認を仰ぐ
- 「どんどん進んじゃって」— 実装スピード重視だが検証は省略しない
- 設計の言い訳コメントはしっかり書く文化（なぜその値か・何を防ぐか）
 Portal 側の正確な要件を local-development.mdx + building-an-activity.mdx で確認済み（シェルフに出る条件）: (a) Activities→Settings の Enable Activities ON、(b) Supported Platforms に現プラットフォームのチェック、(c) Installation→User/Guild Install 両方ON、(d) Developer Mode ONでVC参加中のアカウントがアプリ所有/チーム所属、+アプリ名で検索可。URLマッピングのTARGETは https:// を付けない（hostのみ）。OAuth2 Redirectsはプレースホルダ https://127.0.0.1 でよい（SDKが内部処理）。Application URL Override（アプリID+ローカルURL直指定）は存在するが desktop/web はHTTPS必須で http localhost 不可 — tunnel が正攻法。Discord proxyはWebSocketを通す（networking.mdx 明記）。
### Task 40 完了（2026-09-27）— ゲーム体験の調整一式: orderForRound(roster, round, hostId)でホスト起点の時計回り（create/advanceTurn/roomHudの3箇所、settings.hostId優先・hostPlayerIdフォールバック、turn-order.test.ts追加）。座席avatarはIconFace SVG（ミニ顔）、○Aは名前ピル内.tagへ。PullCue: 判定ごとにarena中央→勝ち座席へ矢印1.7s＋data-pulledパルス、room-arena.pulledSlotヘルパー。useOutcomeReveal: finishedから2.4s『さあ、けっかは…』ベール（?reveal=0で短縮）。メニュー拡張: turnSeconds +45/60、liveSeconds +300(5分)/600(10分)、rounds 1..8（protocol/game-core/GameSettings/contract test全部）。Discord: lobbyに『メンバーをよぶ』shareLink（全員可）、RoomPlayerView.platform追加（wire.ts組み立て→player-view.ts分離）、bootstrap.getDiscordSdk遅延シングルトン。罠: apply_patch中のバッククォートは要エスケープ、rg -rnは置換フラグ、exec 30s超はsession_id+write_stdinでpoll、playwrightはwebServerのworkerdを残すことがある。
