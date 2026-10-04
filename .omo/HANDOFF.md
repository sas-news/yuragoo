# ゆらぐー！ 引継ぎ（2026-09-26）

このファイルはセッション間の引継ぎ。最新の状態をここに集約する。

## 最新（2026-09-27）
- **staging を workers.dev にデプロイ済み → 固定URL https://yuragoo-staging.sasshinbun0655.workers.dev**。wrangler login済み（sasshinbun0655@gmail.com）。env.staging vars: APP_ENV=production / ALLOWED_ORIGINS=自身URL / DISCORD_CLIENT_ID / DISCORD_ORIGINS=.discordsays.com / JEV_DAILY_ATTEMPT_CAP=120。secrets: DISCORD_CLIENT_SECRET / JEV_API_KEY（.dev.varsからwrangler secret put）。検証済み: /→SPA, /api/health→200, discordsays origin POST /api/rooms→200。Discord URL Mappings の「/」ターゲットは yuragoo-staging.sasshinbun0655.workers.dev（スキームなし）。コード更新は bun run deploy:staging。quick tunnelよりこちらを使う。
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
bun run check          # biome + 全tsconfig + 境界/LOC（314ファイル）
bun run test:unit      # 184 tests
bun run test:workers   # 126 tests（vitest-pool-workers、例外ログはnegative-path想定出力）
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
- Task41: Discordアバター配線+ready解除はmode変更時のみ+紙芝居eventId昇順+figcaption固定高+締切自動送信+招待custom_id/フォールバック+Discordタグ削除+表情を分布導出(room-expression)+お題プリセット。.dev.varsにAPP_ENV=local必須。staging再デプロイ済(67110e4時点, workers 126/126 green, APP_ENVピンはテストbinding側で対処)。

- Task41b: eval:jev live 実行(ja-v1) — baseline 10/12 pass。poison-label(毒札きのこ>我慢)を修正するため INSTRUCTIONS に『行動しない選択肢も有効/安全なら高評価/近い魅力には近い確率』を追加し 11/12 に改善。close-call(close margin 0.3)はモデルの決断癖で残留、instructions では解決不可と判断。artifacts/ は gitignore+biome ignore 済。manifest は artifacts/eval-ja-v1-iter4.json。staging再デプロイ済。

- Task42: (a)ABCDずれ修正 — reducer.createGame の seededShuffle を廃止し slot=joinOrder(ChoiceEditor行i=members[i]と一致)。seedはsettings互換で残存。tests: rules.test.ts を join-order assertion に、コメント類追従。(b)招待ボタン修正 — 根本原因は bootPlatform が ready()済みSDKを持つのに InviteButton が getDiscordSdk で別インスタンスを未readyで作成していた点。getDiscordSdk を唯一のシングルトンに統一。加えて shareLink の success:false は『閉じた』ので失敗扱いしない tri-state(shared/cancelled/failed)化、openInviteDialog フォールバックは guildId null(DM)/CREATE_INSTANT_INVITE 権限でゲート。tests/unit/platform/share-invite.test.ts 追加。stagingデプロイ済(26e6282)。

### Task 43（2026-09-27）— Jev が生きものの気分を選ぶ + eval margin 実測緩和

**表情パイプラインを分布形状ヒューリスティックから「Jev の mood 判定」優先へ拡張**（commit 75747dc）:

- `protocol/decision.ts`: `MOOD_IDS`/`moodIdSchema`（rest/hesitating/engaged/bored/adhering — creature の CreatureExpression と同じ語彙を protocol 側に所有）。`createJevRequestBody` に第2の `mood` 質問を追加（**同じリクエスト=同じ quota 枠**、実APIで複数質問の同居を probe 確認済み）。`parseJevDecisionResponse` は mood をレニエントにparse（厳密5キー+unit sum のみ受理、argmax。 malformed→undefined で attraction 判定は殺さない）
- wire: `decisionUpdated` payload と snapshot に `mood`/`moods` を optional 追加。`decision-commit.ts` がイベントに mood を同梱、`ai-jobs.ts` の `landedMoods()` が ai_results の result.mood を検証付きで復元、wire.ts snapshot に `moods: landedMoods(host.sql)`
- client: `room-view.moods`（Map<postId,MoodId>）を snapshot/epoch/lobbyReopened で整合。decision fold は LOC対策で新設 `view-decisions.ts` へ分離（view-members.ts パターン）。**不変条件: 表情 mood は現在の pull を出した postId と必ず同一の verdict から引く**（`latestVerdictPostId`+`moodOf`）
- `room-expression.ts`: `expressionFor(dist, mood, ...)` — mood!=null なら最優先、なければ従来の形状ヒューリスティック。`RoomGame` と `LocalSession`(/play) 両方に配線（local loop も moods Map を持つ）
- mock provider は自分の pull から mood を導出（top>=0.78 adhering / >=0.5 engaged / else hesitating — bored はidle時計要なので出さない）
- tests: `tests/unit/ai/mood.test.ts`（質問shape・parse・degrade・mock）、`room-view.test.ts` に fold/snapshot heal/同post pairing、room-expression に mood 優先ケース。184 unit / 126 workers green

**JEV close-call margin（commit 461277d）**: 提案の 0.45 では実測に合わない — live probe で同等二択の観測 |a-b| は 0.44〜0.54（n=6、jev-1.13 は同等でも ~74/26 に決断する癖）。**0.6 に緩和**（80/20 超の退化した決断は依然弾ける）。ja-v1.json の description も実態に正直化。加えて GameSettings の stale copy「設定を変更すると準備OKがリセット」→ mode変更時のみの実装に合わせ修正。

**staging 再デプロイ済**（version 65ae7ef4、/ と /api/health 200確認）。

**live eval 注意**: eval:jev 実行は JEV_DAILY_ATTEMPT_CAP=120 を消費する。今回 quota 途中枯渇で worldview-break 以降が error:quota — **mood質問を載せた最初4ケース（poison-label含む）は全パス**していたので質問追加の回帰はなさそうだが、全12ケースの再確認は quota リセット後に要実施。

**残課題**: AIお題生成（scenario-presets+choice-generation/generate-choices の枠再利用）、Task 37 実Discord QA（ABCD一致・招待ボタン・PIP表示の実機確認）、F1〜F4、quota 復帰後の eval:jev フルラン。

### Task 44（2026-09-28）— AI お題生成（シナリオ生成）

**ロビーに「AIでお題をつくる」ボタンを追加** — choices生成と同じ host-only/click-only/proposal-必須 契約を **独立した "scenario" スロット**で実装（両アシストを同じロビーで使える）:

- `protocol`: `generateScenario` コマンド、`scenarioGenerated` イベント（{lobbyRevision, scenario}）、`generationFailed.scope`（"choices"|"scenario"、optional — 無記載は従来の choices 解釈）、`LobbyState.scenarioSpent`。generation_slots に `"scenario"` 追加（reset の DELETE FROM は行を巻き取るのでゲーム開始で自動リセット）
- `ai`: `scenario-generation.ts`（buildScenarioPrompt/scenarioJsonSchema/parseScenarioText — 改行→空白正規化、trim、grapheme上限超過は GenerationProviderError）。`GenerationRequest.kind` に "choices"|"scenario"|"ending"（mock/fixture が schema を読めなくても形を判別できるよう）。Mock/Http provider 共通のまま
- server: 共通 async 配管を `generation-run.ts` に抽出（reserve→claimSlot→callProvider(deadline)→consume/release→emitOutcome/failOutcome）。`generate-scenario.ts` は scenario 空欄不要・**ソロホストも可**（誰もいなくても下書き可）で choices との差分のみ。`lobby-commit.ts` の commit は両種で共有
- client: `view-proposals.ts` 新設（proposal/failure fold を room-view から分離 — LOC対策+scope別spent）。`use-scenario-generation.ts` フックに busy/proposal/apply を集約し `ScenarioEditor` に props 注入（apply は通常の revision-gated updateLobbyContent）。`sync.ts` ORDERED + `client.ts`/`reconnect.ts` に generateScenario
- tests: `tests/unit/web/view-proposals.test.ts`（scoped/unscoped failure、両 proposal 独立）、`tests/workers/scenario-generation.test.ts`（happy/gates/failure scope）、`tests/e2e/lobby/scenario-gen.spec.ts` + gen-fixture に scenario 分岐（garbage は非文字列を返すよう変更 — 裸stringは有効なscenarioとして受理されるため）。187 unit / 129 workers / e2e 2件 green、check（biome+tsc8+boundary 322files）pass

**LOC注意**: MAX=250行だが split("\n") 計数のため実質 249行が上限（末尾改行が+1）。dispatch.ts は return 圧縮で対応。

**staging 再デプロイ済**（commit 4870ec8、version 409af13d-638f-4343-97ee-72d64519e894、/ と /api/health 200確認）。

**残課題**: Task 37 実Discord QA、quota 復帰後の eval:jev フルラン。

### Task 44 フォローアップ — staging 生成が generation-config で全否認（commit eacd51c + 90b35c2）

- **原因**: staging vars に `GENERATION_DAILY_ATTEMPTS` 未設定 → `parseCap` fail-closed で reserve 全否認（choices/scenario/ending 共有カウンタの設計上の正しい動きだが設定漏れ）。`"60"` を staging vars に追加。**production env には vars ブロック自体が無い**ので本番デプロイ時は JEV_DAILY_ATTEMPT_CAP と同様にダッシュボード側で設定必要。
- ついでに live probe で2件観測・修正: (a) Qwen3 が英語でお題を返す → プロンプトに「出力は必ず日本語で」+プリセット例行を追加、(b) 10s deadline が Workers AI コールドスタートで slot を燃やす → `GENERATION_TIMEOUT_MS=20_000`。
- 招待ボタン: shareInvite が RPC エラーを丸呑みしてたので `console.warn("[yuragoo] ...")` で実エラーを iframe console に出す（platform pkg は DOM lib 無しなので structural console）。DM 通話では guildId null → dialog 不可 → 「招待できませんでした」は仕様通りの失敗。
- staging probe 手順: `tmp/probe-scenario-staging.ts`（create→join→ticket→WS generateScenario、実 API を叩く — gitignore 済み tmp/ に配置）。live で scenarioGenerated 正常確認済み（日本語応答）。

### Task 45 — solo ホストの選択肢 prep + 日本語プロンプト統一（commit 80ae221、staging 0cab962e）

- **要件**: 「メンバーいないうちに選択肢を準備したい」→ `generateChoices` の 2人以上ゲート撤廃。solo ホストは **6席分** を生成、2人以上は表示中行数分（orphan行も埋める）。適用時に `updateLobbyContent` が連番 `c{n}` append を受理（LOBBY_SEAT_COUNT=6 上限、飛び番は unknown-choice）。既存 orphan 機構に自然に載る — joiner は prep 済みラベルの座席に入る。
- **日本語プロンプト**: choices も scenario と同じく「出力は必ず日本語で」+出力例を明記（実機で英語ラベル混入を観測したため）。`buildChoicePrompt` の人数引数は座席数として使用。
- client: `applyProposal` が全ラベルを送る（`lobby.choices[i]?.choiceId ?? c${i}`）。
- tests: `choice-prep.test.ts` 新設（solo→6件生成→append適用→非連番拒否）。gates テストから lobby-too-few 断言を除去。unit 187 / workers 130 / check green。
- **live 検証済**: solo 部屋で `generateChoices` → 6件日本語ラベル（「無人店で物を盗む」等）。`tmp/probe-prep-staging.ts`（snapshot→revision取得→scenario設定→generateChoices）。1度 `generation-invalid` 観測 — Qwen3 の出力揺らぎで parse 失敗すると slot 消費（one-shot 設計どおりだが flake 耐性は弱い）。
- **招待ログの見方**: `console.warn("[yuragoo] ...")` はクライアント側（Activity iframe の devtools console）に出る — wrangler tail 等サーバーログには出ない。Discord は bundle を強くキャッシュするのでハードリロード必要な場合あり。

### Task 46 — お題AI生成を撤去（ユーザー判断）

- ユーザーが「いらない気もする」→ 確認の上で撤去。Task 44 の scenario 系のみ外科的除去（choices 側の共有配管 generation-run.ts / kind / prep は維持）。
- 削除: `generate-scenario.ts` / `scenario-generation.ts` / `use-scenario-generation.ts` / `scenario-generation.test.ts` / `scenario-gen.spec.ts`、protocol の `generateScenario`/`scenarioGenerated`/`LobbyState.scenarioSpent`、`generationFailed.scope`、generation_slots の "scenario" スロット、ScenarioEditor の生成UI、RoomView.scenarioProposal、gen-fixture の scenario 分岐。
- 維持: `GenerationRequest.kind`（choices/ending 識別に使用中）、`GENERATION_DAILY_ATTEMPTS`（choices/ending で消費）、solo prep（Task 45）。
- 既存DBの "scenario" slot 行は残り得るが読み側は slot 名で引くだけなので無害（parseSlot からは除去）。
- unit 187 / workers 127 / check green。staging `7f4654aa` デプロイ済。

### Task 47 — 4件の現行問題まとめ対応（commit 1b57db3、staging 6d9f0a3d）

ユーザー報告「招待できない/選択し生成できない/soloで準備できない/お題選択はポップアップで」への対応。

- **招待**: `shareInvite` の失敗を型付きに — `{reason: "dm"|"no-invite-permission"|"error", detail}`。iframe devtools がユーザー環境で読めなかったため console.warn ではなく**トースト自体が診断を運ぶ**設計に変更。InviteButton が日本語メッセージに変換（DM/権限なし/RPC詳細付き）。残リスク: `getDiscordSdk` 自体の失敗は従来どおり一律「招待できませんでした」。
- **生成できない（推定原因）**: シナリオ空で `generateChoices` → `lobby-scenario-empty: the scenario is empty` の英語生toastが出ていた。対策: (a) GenerationControls に `scenarioEmpty` prop — 空なら disabled + 「シナリオを入力すると生成できます」ヒント、(b) `lobby-errors.ts` 新設でコマンド拒否 `code: msg` → 日本語マップ（scenario-empty/spent/not-host/revision-conflict 等）、Lobby.tsx の reportError で全 catch を通す。
- **solo準備**: サーバー側は Task 45 で実装済（deployed 0cab962e）。表示側は既存 orphan 行「（空き）」で自然に見える。今回新たな変更なし — ユーザー環境が旧バンドルだった可能性が主原因。
- **お題ポップアップ**: ScenarioEditor が Dialog で SCENARIO_PRESETS 全10件をカード表示 → 選択で onEdit+閉じる。pickScenarioPreset（即時ランダム置換）は削除。`.presetList/.presetOption` CSS追加、e2e に presets spec 追加（editor.spec.ts）。
- 検証: check / unit 187 / workers 127 全 green。staging `6d9f0a3d-473e-4c7a-aca4-bde2a452ca0c` 稼働確認（/ と /api/health 200）。
- **残**: Discord 実機で招待ボタンを再試行してもらい、トーストの文言（DM? 権限? RPC code?）を報告してもらう段階。production には未デプロイ — GENERATION_DAILY_ATTEMPTS の vars 設定が先決。

### Task 47b — 空席ボタン + 招待ステータス常設化（commit fc4ff54、staging 0b3d59f9）

ユーザーFB: 生成は成功、ただし空席を作る手段が無い / Discord ではトーストが表示されない。

- **「＋空席をつくる」ボタン**（ChoiceEditor、editable && choices<6 時）→ `updateLobbyContent` で `c{n}`+空ラベル append。サーバー変更不要（空ラベル行は成長時に label:"" で作られる設計、startGame の blank ゲートのみ制約）。workers テスト追加: 空ラベル append で orphan 行増加 + startGame は gated。
- **招待ステータス常設行**: InviteButton に `status` state（info/ok/error）+ ボタン下の `<p role="status">` — 「Discord に接続中…」「招待画面をひらいています…」「招待を送りました」「（キャンセル）」「失敗＋detail」が画面に残る。トースト非依存。共有エラー行にも引き続き出力。
- staging `0b3d59f9-165c-4d2f-b5b4-8803b18a6582` 稼働確認。**次回 Discord 実機で招待ボタンを押した時の status 行の文言を聞けば失敗経路が確定する**。

### Task 47c — 招待失敗の根本原因修正（commit c83a757、staging 6f1c5457）

ユーザーの status 行報告「招待できませんでした（frame_id query param is not defined）」で確定。

- **原因**: `DiscordGate.tsx` が `/r/<id>?platform=discord` へ遷移する際、Discord 注入の `frame_id`/`instance_id`/`platform`/`guild_id` を全て破棄。部屋ページで `new DiscordSDK()` が location.search から frame_id を読めずコンストラクタが即 throw — SDK v2 の必須パラメータ（frame_id/instance_id/platform=desktop|mobile のみ）。
- **修正**: `location.assign(`/r/${id}${window.location.search}`)` でクエリ丸ごと引き継ぎ。`platformKind()` は frame_id で判定されるので platform=discord マーカー不要（SDK にとっては不正値だった）。
- 招待ステータス行（47b）がこの診断を可能にした — 設計意図どおりトースト非依存で原因可視化。

### Task 47d — 「ひらいています…」ハング対策（commit a8e2146、staging adee1052）

- **原因候補2点**: (a) 部屋ページの DiscordSDK は ready()/authenticate() 未実行（ゲートで完結してるが別ページロードなので新規インスタンス）→ `sendCommand` は `pendingCommands` に応答待ちで**タイムアウト機構が無く無応答だと永久ハング**。Discord が unauthenticated コマンドを無音で落とすとこの症状になる。(b) shareLink モーダルが iframe 背面に開いて見えない。
- **修正**: InviteButton が `bootPlatform` を再実行（prompt:none で再同意は無音）→ ready+authenticate 済みブリッジを保証。`shareInvite` が `sdk.ready()` を明示 await（15s 上限）し、shareLink/openInviteDialog に30s deadline — ハングではなく `timeout:sdk-ready / timeout:share-link / timeout:invite-dialog` がステータス行に出る。
- platform pkg は DOM lib 無し → `globalThis.setTimeout` structural 参照（warn と同型）。
- 次回報告で `timeout:*` が出ればどの段階で Discord が応答を返していないか確定できる。

### Task 47e — boot チェーンのステージ計装（commit 8b41711、staging 0bd907ec）

「Discord に接続中…」のまま = bootPlatform 自体がハング。内部の全 await（sdk-load/ready/authorize/exchange/authenticate）が無制限だった。

- `establishDiscordSession` に `stage`/`deadlineMs`（任意、各ステップ30s deadline + stage 通知）
- `bootPlatform(clientId, onStage?)` で InviteButton がライブステージ表示: 「接続中…（authorize）」等。タイムアウトは `timeout:<stage>` → classified `timeout` → status 行に `timeout:<stage>` 表記
- 次回報告でどのステージで止まるか確定: `sdk-load`=import失敗、`ready`=handshake不成立、`authorize`=同意フロー、`exchange`=token API、`authenticate`=認証

### Task 47f — 根本原因解決: location.assign が RPC ブリッジを殺していた（commit 0a39609、staging f40e967a）

**連鎖の全貌**:
1. SDK の handshake は `window.parent` に `targetOrigin = document.referrer` で postMessage
2. 初回ロード時 referrer=`discord.com`（正しい）→ gate の handshake/authorize は成功
3. `location.assign` で discordsays.com 内遷移 → **referrer が自分自身のプロキシURLに書き換わる**
4. 部屋ページで `new DiscordSDK()` → handshake を `discordsays.com` 宛に送信 → Discord(=discord.com)は targetOrigin 不一致で無視 → `ready()` 永久ハング

**修正**: DiscordGate は `history.pushState` で `/r/<id>` に遷移し RoomPage をその場で lazy mount。referrer は `discord.com` のまま、注入クエリも残り、**gate で認証済みの SDK インスタンスがモジュール memo 経由でそのまま部屋画面に引き継がれる**。InviteButton の bootPlatform 再実行は ready() 即解決 + prompt:none で無音。

**教訓**: Discord Activity 内では `location.assign`/`location.href` によるフル遷移は RPC ブリッジを破壊する（referrer が変わる）。SPA 遷移のみ使うこと。同じ制約が他の画面遷移にもかかる — 新規の navigation は pushState 経由で。

### Task 47g — authorize 二重呼び出し INVALID_COMMAND 解消（commit 14c1aaf、staging 13b2c189）

- SPA 化で gate の認証済み SDK が部屋画面に生きている → InviteButton が bootPlatform を再実行すると `authorize` が2度目の呼び出しで INVALID_COMMAND(4002) を投げる
- 招待には authenticate 不要（shareLink/openInviteDialog は client command）→ `getDiscordSdk` + `sdk.ready()`(shareInvite 内、15s deadline) のみに簡素化。`getDiscordSdk` にも15s deadline
