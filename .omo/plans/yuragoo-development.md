# yuragoo-development - Work Plan

## TL;DR (For humans)
**What you'll get:** 友人2〜6人が短い文章で一匹の名のない生命体を引っ張り合い、最後に実際の攻防を紙芝居で笑える「ゆらぐー！」。通常ブラウザとDiscord Activityの両方に対応し、招待・編集・対戦・振り返りまでを完成させます。

**Why this approach:** 最初に生命体の柔らかさ・表情・動く楽しさを証明し、そこへJevの判断、ローカル対戦、ネット対戦、編集、紙芝居、Discordを順に接続します。見た目だけ、AI接続だけで完成とせず、通信障害・費用制限・ルーム削除まで含めて遊べる状態を検証します。

**What it will NOT do:** ゲーム中の通常LLM・画像生成、生命体への命名、確率バー、個人ランキング、長期試合履歴、公開マッチング、アカウント/課金/VC機能は作りません。

**Effort:** XL — 全7段階を39の実装・テスト作業と4つの最終検証に分割。既存の製品コードはありません。
**Risk:** High — 生命体の動作品質、日本語Jevの判断品質、実Discord認証・通信、非同期処理と短期データ削除が主要リスク。実サービスの資格情報がない場合、その検証は未完了として明示します。
**Decisions to sanity-check:** 承認済みの公平性優先TURN/LIVE、Jev最大120試行・通常生成は前後各1試行、招待制、ホスト自動引継ぎを採用。全文はルーム中だけ保持し、明示終了または全員不在60秒後にアプリから削除、残すのは匿名の集計だけです。復旧用バックアップやAI提供元側の物理削除までは即時保証しません。

Your next move: 別の作業セッションで実装を開始するか、この計画の高精度二重レビューを先に実施するか選んでください。この計画作成セッションでは実装を開始しません。

---

> TL;DR (machine): XL / High / 7 waves, 39 implementation-and-test tasks, 4 final verifiers / full YURAGOO Web + Discord invitation-only game.

## Scope
### Must have
- 根拠は `ゆらぐー！開発エージェント向け指示書.md` v0.1（以下 **S**）。会話の承認事項はこの計画が明文化し、相違時は本計画の確定判断を優先する。原本は上書きしない。
- 開始時点はgreenfield。既存はS、`.codegraph/`、`.omo/`のみ。以下の製品パスは**実装時に作る予定のパス**であり、既存コードの参照ではない。
- 6領域: 生命体/演出、ゲーム規則、AI、ルーム/同期、ロビー/編集/紙芝居、Web/Discord。S:1271-1345の順を7つのwaveで守る。
- 2〜6人に1選択肢ずつ公開割当。1人sandboxは開発専用。TURN/LIVE、手動シナリオと選択肢、任意生成、紙芝居、招待参加、ホスト引継ぎ、接続復旧、削除、公開匿名集計を含む。

### Reference register（以下の略号は各todoの参照に含まれる）
| ID | 一次資料 / 正確な参照先 | この計画に使う事実 |
| --- | --- | --- |
| J1 | https://docs.typesafe.ai/api ; https://docs.typesafe.ai/primitives/choice | POST /v1/systemone、state/model/questions、Choiceの分布 |
| J2 | https://docs.typesafe.ai/models ; https://docs.typesafe.ai/model-jaggedness/jev-1.13 | jev-1.13.0、日本語の独自eval、入力価格、変動rate limit |
| J3 | https://docs.typesafe.ai/confidence ; https://docs.typesafe.ai/patterns/fan-out | confidenceと確率の区別、同一stateの独立質問 |
| C1 | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ | hibernation API、attachment、deploy切断 |
| C2 | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ; https://developers.cloudflare.com/durable-objects/api/alarms/ | transactionSync、deleteAll、PITR、単一alarmと再試行 |
| C3 | https://hono.dev/docs/getting-started/cloudflare-workers ; https://developers.cloudflare.com/durable-objects/testing/ | Workersランタイム、Workers Vitest integration |
| G1 | https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/ ; 同URLのsync-input.jsonとsync-output.json | Workers AIモデルとJSON schema・生成上限 |
| P1 | https://pixijs.com/8.x/guides/components/application ; https://pixijs.com/8.x/guides/components/scene-objects/mesh | 非同期init、動的頂点mesh |
| P2 | https://pixijs.com/8.x/guides/components/renderers ; https://pixijs.com/8.x/guides/concepts/performance-tips ; https://pixijs.com/8.x/guides/components/ticker | extract、性能、ticker寿命 |
| D1 | https://docs.discord.com/developers/activities/building-an-activity ; https://docs.discord.com/developers/developer-tools/embedded-app-sdk | ready/authorize/authenticate |
| D2 | https://docs.discord.com/developers/activities/development-guides/multiplayer-experience | instanceId、Bot認証Activity Instance API、users membership |
| D3 | https://docs.discord.com/developers/activities/development-guides/networking ; https://docs.discord.com/developers/activities/development-guides/local-development | proxy、URL mapping、CSP、cookie |
| D4 | https://docs.discord.com/developers/activities/development-guides/mobile ; https://docs.discord.com/developers/activities/development-guides/layout ; https://docs.discord.com/developers/activities/development-guides/production-readiness | safe area、PIP/grid、キャッシュ、旧SDK互換 |

資料確認日は2026-09-19。料金・利用可能性・速度保証を実測済みと扱わない。公開資料にないレイテンシーをSLAにしない。

### Architecture contract
- Bun workspace。`apps/web`=React/Vite/CSS ModulesとPixi canvas host、`apps/server`=Hono Worker、`packages/game-core`=純粋ルール、`packages/protocol`=Zod v4境界schema、`packages/creature`=描画/変形、`packages/ai`=provider/context/evals補助、`packages/platform`=Browser/Discord adapter。用途のない`shared` packageは作らない。
- `game-core`はReact/Pixi/Discord/Cloudflare/ネットワークに依存しない。creatureは意思と演出イベントを入力とし、勝敗を計算しない。AI秘密鍵はサーバーのみ。
- Pixiはv8を直接Reactのcanvas hostにマウントし、毎フレームReact stateを更新しない。追加のReact-Pixiラッパー・物理エンジン・WebGPU専用実装は不要。
- Workersが本番ランタイム。Bun.serveやNode専用APIをサーバー製品コードへ入れない。外部HTTPは`ky`、retry=0にして予算管理側だけが再試行を制御。Cloudflare bindingのfetch/AI.runはネイティブ契約を使用。
- `GameRoom` DOはランダム256bit roomIdで1ルーム1インスタンス。補助の`ControlPlane` DO（1 deploymentの`control-v1`）だけが日次予算・短命な有効ルーム対応・匿名集計を管理。D1/R2/KV/外部DB/ORMは追加しない。招待制の小規模運用を対象とし、無制限負荷を約束しない。
- Phase 2では公開しないローカル専用Worker gatewayとセッション内quotaのみ。複数ルームを公開する前にWave 4でControlPlaneの原子的quotaに置換する。
- TypeScript: strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes/verbatimModuleSyntax、readonly/branded ID、exhaustive union、Zodで外部をparse。any/非null assertion/型ごまかし/空catch禁止。生成ファイル以外250 pure LOC上限。mutableな数値バッファのみ理由を明記。
- schemaVersion=1、protocolVersion=1。将来の変更は明示migrationか非互換エラーで扱う。依存ライブラリはWave 1に安定版と互換性を確認しexact version＋bun.lockに固定（Pixiは8.x）。lockfile手編集禁止。

### Game and input contract（可逆な初期調整値、docs/game-rules.mdへ転記）
- 初期personaは「甘いものと楽なことに惹かれる。危険や出費は避けたいが、好奇心で妙な噂にも揺れる」。名前・詳しい生い立ちは与えない。
- 初期シナリオは酸素不足の宇宙コロニー、4択は脱出艇/修理/最後のプリン/寝る。2〜6人の本番選択肢はホスト編集。choiceIdはラベル変更と独立、ゲーム開始後はラベル・人数・設定を固定。
- 投稿上限140 grapheme、シナリオ1000、選択肢40、表示名24。Intl.Segmenterを共通利用し結合文字/絵文字/日本語を壊さない。入力schemaの空白処理を共有。WS frame上限16KiB、投稿1件最大2KiB UTF-8、ホスト設定payload最大16KiB。超過を切り捨てずエラー。
- TURN: 3ラウンド（設定1〜5）、1枠20秒（10/20/30選択）、1枠1投稿またはpass。最初の並びはサーバーseedでshuffle、各ラウンド開始位置を1人ずらす。タイムアウト=pass。投稿を受理した後は評価/失敗処理まで次枠を開けず、全員に同数の枠を与える。切断枠は期限後pass、途中joinは次試合ロビー待機。
- LIVE: 120秒（60/120/180選択）、投稿1件/2秒かつ15件/rolling60秒/人。受理数最大240/試合。制限前の却下は予算・AI・意思に影響しない。
- 重複: NFKC＋小文字＋空白/句読点縮約した照合文字列を作り、原文表示は維持。同一プレイヤーの過去60秒の既出完全一致はログに残してneutralな飽き演出だけ、AI dirtyにしない。文字bigram Jaccard>=0.85かつ双方8文字以上は類似グループ化。短文の意味的言い換えはJevの入力説明とevalで扱い、heuristicが意味を理解すると主張しない。
- 終了phaseは`lobby -> starting -> playing -> settling -> ending -> results`、取消は`aborted`。AI故障で未評価投稿が残ったままwinnerを作らない。`roomClosed`は試合終了と別の不可逆ルーム状態。
- 通常終了はTURN枠完了/LIVE期限。serverTime>=deadlineの投稿は拒否。deadlineより前に受理した投稿を`cutoffSeq`で固定し、settling中は新規投稿不可・最大8秒で最終評価。1試行3秒・最大1再試行をこの8秒内に収める。cutoffまで評価完了した分布の最大値をwinner、最大値の差<=1e-6は同率引分け。評価できなければ`noContest`で勝者なし。
- optional settings: `earlyDecision=false`, `hostDecision=false`。有効時は全員にロビーで表示。earlyは首位prob>=0.75かつ2位との差>=0.20が3秒持続。**未評価の有効投稿が来た瞬間にdwell解除**。TURNでは最低1ラウンド後のみ可能（公平性保証を外す設定と表示）。hostDecisionはホストがsettlingを要求するだけで候補を指定できない。
- 同時終了理由は explicit room close > 通常期限/規定枠 > hostDecision > earlyDecision。いずれも一度だけsettlingに入り、候補の最終確定前にcutoffを評価。吸着見た目はローカル、終了はサーバー時刻で判定し衝突座標を使わない。
- TURNの途中AI失敗も最大8秒でnoContest（ラウンド公平性を偽装して続行しない）。LIVEは通常の更新失敗なら旧姿勢＋障害通知、次のdirtyで回復可能。終端評価失敗はnoContest。最初のbaseline失敗はstartingからロビーへ戻りstart失敗を表示。

### AI and concurrency contract
- Jev: `POST https://api.typesafe.ai/v1/systemone`, Bearer server secret、model=`jev-1.13.0`、質問は`attraction`のChoice 1つ、criteriaはlegal choiceId→説明。固定persona/評価規則をinstructions、シナリオ/投稿はstateのuntrusted claimsとして別フィールド。投稿にsystem権限・tool権限・URL fetch権限は与えない。
- レスポンスをunknownとしてparseし、choice集合完全一致、finiteな0..1、sum誤差<=1e-3を確認後のみ再正規化。unknown/missing choice、NaN、不正sum、model不一致はprovider contract error。confidenceは別フィールド、低いことはエラーではない。分布を「ゲーム内の傾向」に使い、日本語の正確性保証と混同しない。
- `DecisionProvider.evaluate`はimmutable input `{gameId, gameEpoch, requestSeq, coveredInputSeq, rulesVersion, state}`とAbortSignalを受け、結果/型付き失敗を返す。APIが返さないrevisionはサーバーがenvelopeとして保持し、モデル出力から信頼しない。
- `stateRevision`=全状態イベント、`inputSeq`=受理投稿、`requestSeq`=評価ジョブ、`appliedInputSeq`=反映済み範囲を分離。結果は同game/epoch/rulesで、現在有効なjob/attempt tokenに一致し、最後の適用requestSeqより新しいときだけ適用。**新しい投稿の存在だけで、より前の未適用評価結果を捨てない**。coveredより後はpendingのまま次評価へ。posthumous/timeout済みattempt・reset前結果は捨てる。
- LIVE single-flight、debounce250ms、最初のdirtyからmaxWait1000ms、開始間隔>=1000ms。実行中はdirtyフラグで最新pendingをまとめ、完了後に次を必ず予約。投稿がない定期AI呼び出し禁止。baseline1回、最終cutoffがすでに反映済みなら追加評価不要。
- Full Logは全原文/受理結果/投稿者/seqをルーム寿命内で保存。Active Contextはscenario+choices+直近各player最大2件（最大12）+high impact group最大3件、重複排除してseq順。各評価の新規未評価投稿batchも必ず含める。batch上限48件に達したら追加受理をBACKPRESSUREで停止し、未評価投稿を黙って捨てない。request JSON UTF-8上限24KiB、超過時は古いhigh-impact→古いrecentの順に除外、新規batchは分割して順次評価。settling8秒で追いつかなければnoContest。
- 自由投稿をpersistent factへ自動昇格させない。必要な既存事実は固定scenarioのみ。Jev/通常LLMでゲーム途中の要約はしない。
- impactは分布差と最大絶対差を記録。1新規投稿ならsingle、複数ならgroup＋members。重複だけは0。groupの差を最後の人の功績にしない。これは観測差であり因果証明ではない。
- Jev総試行<=120/game（baseline/retry/final含む）。通常更新は118まで、最後の2枠をsettling用に予約。通常枠118消費時は新規有効投稿を停止してsettlingへ移り、未評価を捨てて勝たせない。119→120は可、121番目は送信せずcounterも120のまま。Jevと通常生成の予算は別counterであり混算しない。判定順序はclosed/phase/deadline/権限→入力schemaとrate limit→pending48件backpressure→通常Jev枠の有無。48件だけなら既存batchを処理して受付再開、118枠使い切りなら終端へ移行。日次枠の拒否はretryを発生させず、terminal evaluation不可ならnoContest。
- 生成: `@cf/qwen/qwen3-30b-a3b-fp8`、temperature0.6、max_tokens1024、stream=false、schema指定JSON。返却構造はG1 raw schemaに照合。思考テキストは表示しない。入力UTF-8<=12KiB、deadline10秒、SDK/HTTPの自動retryなし。準備中1試行、終了後1試行、失敗も消費。新gameIdは前試合終了後の明示rematchでのみ発行し、設定変更で枠を再発行しない。
- 初期価格記録: Jev入力$0.042/Mtoken・出力無料、生成入力$0.0509/M・出力$0.335/M（2026-09-19）。これは推定用で料金保証ではない。
- `JEV_DAILY_ATTEMPTS`と`GENERATION_DAILY_ATTEMPTS`は正の整数の明示設定がなければ実API禁止。開発example値は1200/20、overrideは運用設定。ControlPlaneはUTC日次原子予約をし、予約済み不明結果も消費したままにする。制限は回数でありインフラ全体の金額hard capではないとREADMEで明示。UIクリックや複数ルーム、eval CLIも同じgateway経由で予算を消費。

### Room, protocol, auth and lifetime contract
- `GameRoom` SQLite: `room_meta`（epoch/phase/revisions/snapshot/settings）、`players`（random playerId、joinOrder、接続lease、platform mapping）、`commands`（playerId+commandId PK、fingerprint、ack）、`events`（seq PK、type、payload）、`deadlines`（id PK、runAt）、`ai_jobs`（attempt token・cutoff・状態）、`ending`（構造化panel/pose）。SQLはbound params、同期transactionで更新＋event＋dedupeを一緒に確定。HTTP待機をtransaction内に置かない。
- API: POST `/api/rooms` create、POST `/api/rooms/:id/join`、POST `/api/rooms/:id/reconnect`、GET `/api/rooms/:id/ws` upgrade、POST `/api/discord/session`、GET `/api/stats`。診断はGET `/api/health`。dev-only gatewayはPOST `/api/dev/evaluate`で本番routeへ登録しない。
- Client envelope `{protocolVersion, commandId, gameId, expectedGameEpoch, type, payload}`。submitText/pass/startGame/updateLobby/requestDecision/rematch/closeRoom/heartbeat。playerId/hostは接続sessionから決め、payloadの自己申告を信じない。同commandId別payloadはIDEMPOTENCY_CONFLICT。
- Server envelope `{protocolVersion, eventSeq, stateRevision, gameId, gameEpoch, serverTime, type, payload}`。snapshot/ack/inputAccepted/decisionUpdated/phaseChanged/hostChanged/presenceChanged/roomClosed/error。probabilitiesはクライアントで身体を演じるため送ってよいが、通常UIに数値表示しない。イベント番号の欠落はsnapshot再同期。60fps座標送信は禁止。
- Browser招待は256bitランダムsecret、URL fragmentで渡してhistory.replaceStateで消し、join POST bodyで交換。サーバーはhashのみ保存。ログ/referrer/URL queryへsecretを残さない。招待はルーム寿命中有効、7人目拒否、途中参加はロビー待機。Web/Discord間の混合ルームは作らない（両adapterは同core、別の入室権限）。
- Reconnect tokenはserver発行、sessionStorageのみ・サーバーhash保存・復帰時rotation。WSはsingle-use30秒ticketをqueryで渡すがproxy/applicationログではqueryを必ずredact。cookie依存は避ける。Origin allowlist、upgrade前認証、ticket消費はDOで原子的に実施。同playerの重複socketは新接続が旧接続を置換、旧closeイベントで新presenceを消さない。
- heartbeatはアプリから15秒、lease45秒。サーバーが切断/期限切れを検知した時点で、接続中の最小joinOrder（同値playerId辞書順）へhostを引継ぐ。旧host復帰でも奪回しない。明示leaveは即検知。招待リンク保持だけではhost不可。
- 最後の接続が消えたらemptySinceを保存し、**playing中のゲーム時計・turn/dwellだけ**pause、60秒再接続猶予。復帰時は停止時間分それらの期限をずらし評価を再開。starting/settlingのAI timeoutと8秒hard deadline、生成10秒deadlineは停止しない。settlingは無人でも一度だけ結果確定し、残り猶予内の復帰者に表示、猶予終了で削除。playing中に始まったAI結果は保存可能だが次turnへの進行は復帰まで保留。期限到達後のjoinは拒否し、alarm遅延中もread/join/command入口でexpiredを判定。
- explicit `closeRoom`は現hostのみ、確認dialogあり。任意の結果画面からrematch可能（全員準備→新gameId、過去試合ログはroom内でのみ保持）。room資源上限: 原文+event+pose合計8MiB、20試合、継続12時間。達した場合は次の試合開始を拒否して終了を案内、既存本文を無断切捨てしない。
- 閉鎖: まずControlPlaneのactive mappingをrevoke、GameRoom epochを無効化し全socketを閉じる、メモリ/クライアントstate/Blob URL/textureを破棄、`deleteAll()`（compatibility_date=`2026-09-19`）で本文・参加者・token・alarm・jobを削除。constructorは空DBを勝手に新roomとして初期化しない。初期作成は内部create routeだけ。遅いAI/生成/集計callbackはepoch＋room存在を検査し新rowを作らない。
- 削除失敗中はclosedとしてアクセスを拒否し再試行。active registry失効にもlease上限を設定、外部障害で永続roomを残さない。配信停止/再起動後も起動時expired purge。アプリの即時論理削除とCloudflare PITR/バックアップ（公開仕様は30日）、AI提供元の保存条件を区別し、物理的即時消去は約束しない。稼働中roomのPITR restore機能は製品に作らない。
- 公開は`completedGames,totalMessages,totalDurationMs`のglobal totalsと平均時間だけ。20完了試合未満は公開pending、以降は前日までの日次集計、UTC日単位更新。表示名/ID/本文/自由選択肢名/個別勝者/room別統計なし。noContestと開発/eval試合は公開集計に含めない。
- 集計は終了時にControlPlaneへserver-only submit。roomとは無関係なrandom receiptIdで24時間dedupe、payloadは上記数値だけ。outboxはGameRoom SQLiteに置き、**ルームが生きている間だけ最大5分retry**。閉鎖時はoutboxもdeleteAllで破棄し、集計待ちで削除を遅らせない。閉鎖前に送信済みの数値payloadをControlPlaneが受けることは可、GameRoomへcallbackで再作成は禁止。24時間を越えたreceiptは拒否し再カウントしない。集計の一時欠落は許容する。ControlPlaneの受理済receiptにはroom/player/gameへの逆引き情報を残さない。
- DiscordはOAuth codeをserverでexchangeしGET users/@meとD2 Activity Instance APIのusersで一致検証。最小scope identify。clientIdは公開可、clientSecret/Bot tokenはWorkers secrets。SDK authenticate用access tokenはクライアントへ一時返しメモリのみ、ゲーム用sessionに交換後は永続保存しない。トークン期限切れは再認証、SDK RPCだけで本人確定しない。
- ControlPlaneのactive mappingは`(applicationId, instanceId)->random roomId`でroomと同寿命。既存mappingをjoin、閉鎖後の新roomは明示create＋verified membershipのみ。instanceId/channelIdを知っているだけの第三者に履歴を返さない。Activity参加はjoin/reconnectとゲーム開始時にserver確認。optional proxy署名を必須認証の代替にしない。

### Visual and story contract
- ポップで明るい2D舞台、半透明の名のない生命体が主役。Dashboardカード、確率バー、3D、公式の固有名詞は禁止。DOMは入力/アクセシビリティ/ロビー/結果、Canvasは生命体/引力/演出。
- `DESIGN.md`をUI前に作る。素材感は柔らかいゼリーの透過＋内側ハイライト＋接地影、背景は読みやすい暖色off-white。色以外にchoiceIdの形/記号・位置・ラベルを対応。文字は自己host日本語font＋fallback（ライセンスを保存）、UI最小16px、操作領域44px。
- contour64点・極座標の半径変形を第一方式とし、角度順序を維持して自己交差を防ぐ。隣接平滑化、semi-implicit spring、固定1/120秒step・1frame最大4substeps、rを[0.4,2.2]restRadiusへ制限、面積補正target±15%。fan meshの頂点buffer更新、透明重なりの継目を避け、顔は独立transform。体積の物理的厳密さは要求しない。
- normalized attractionから複数lobe/centroid/gazeを連続変化。pop/recoilは80ms以内にローカル予告、server拒否は取り消せる反応で本判断と区別。UIの自発的揺れは生命感/意思に限定。
- WebGL優先、DPR<=2（低負荷mode1）、最大60fps、低負荷30fps。非表示中pause、復帰は最新snapshotへ追従し巨大dtを積分しない。reduced-motionでは振動/粒子/flash/shakeを停止し、100ms以下の姿勢遷移で判断を残す。WebGL非対応は明確なunsupported表示で開始不可、白画面にしない。
- 375/768/1280pxを基本、360px・横画面・200%拡大・ソフトキーボードも検証。6候補が入力欄の裏へ隠れないようゲームstageと入力dockを別領域にする。canvasに代わる短いDOMの状態説明を非数値で提供。
- `PoseSnapshot`はeventId、decision revision、seed、相対contour/face/attractor状態とrendererVersion。serverが保存するのは決定/seed/論理poseで60fps座標ではない。再接続者も同じ主要場面を再描画できる。画像Blobはクライアントだけ、R2等への画像アップロードなし。
- 終了は5panel（開始、最大逆転、最大impact、終盤、結果）。イベント不足時は重複しない3panelまで削減。title<=40、caption<=80 grapheme、eventIdの許可集合のみ。文章に新しい勝者/固有名詞/実在しない投稿を付け足さない。テンプレfallbackでも全panel表示し、generation失敗は試合結果を変えない。

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 通常LLMのゲーム中使用、画像生成のゲーム中/終了時利用、生命体命名、確率の一般UI表示、カードシステム、秘密の勝利条件。
- 7人以上、個人ranking、アカウント/課金/実績/cosmetics、Steam、VC、公開ルーム一覧・matchmaking、高度なmoderation、長期リプレイ/全文ログ分析基盤。
- Sの例にある「モチ」という名前を採用しない。投稿者が書いた絵文字や破天荒な設定は削除しない。開発者のiconはSVGで用意する。
- secret入り証跡、raw inputの運用ログ、認証sessionの公開endpoint、bundle内Jevキー、Devtools/slider/test hookの本番公開。
- mockによる本番AI判断や実Discord成功の偽装、API料金の勝手な上限引上げ、CIのfail/skipをpassに読み替えること。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **TDD**（Given/When/Then、red原因を確認→green→refactor）。Bunはpure unit、Vitest Workers poolは実workerd+SQLite+WS integration、Playwrightは実browser E2E。スクリーンショットだけで動きの品質を証明しない。
- `attemptDir`はulw-loop使用時currentAttemptDir、それ以外は`.omo/evidence/yuragoo-development/<runId>/`。runIdはUTC時刻＋random suffix、既存証跡を上書きしない。各todoのhappy/failureとred/greenのログ、動画/trace、pose JSONを同ディレクトリに保存。投稿fixtureは合成人物「あいこ/れん/むぎ/そら/はる/りく」のみ。secretはfixtureでもログ対象外。
- コマンドはrootから実行。Task1が `bun run check`（Biome+全package tsc+境界/LOC検査）、`bun run build`、`bun run test:unit -- <file>`（bun test対象fileを渡す）、`bun run test:workers -- <file>`（vitest run -c vitest.workers.config.ts）、`bun run test:e2e -- <file>`（playwright test）を作る。指定fileが0testsなら失敗。default testはlive suiteを含めない。
- Playwright設定はbuild済Web＋wrangler local Workerを起動し、各run固有port/DO storage directoryを使う。fixtureはUIまたはinternal test serverから正規コマンドを送り、状態を後から直接書換えて成功を作らない。test hookはE2Eビルドのみ。本番ビルドで不在を検証。
- 各happy/failureは別testとして実施。同じコマンドで両方を走らせ、ファイル内のtest titleと結果を証跡へ記録。新規testを選択的に1回failさせて検証能力を確認する（製品変更は戻す）。
- live Jevは`bun run eval:jev -- --suite ja-v1 --max-attempts 60`。API availability/latency/日本語判断を別に証明、キーなしは`BLOCKED`＋非zero exit、default CIは未実行として分離。禁止事項はmock schemaとserver権限テストでも検証するが、意味理解はlive evalが必要。
- Discord実接続は`bun run test:discord:live -- --scenario party-four`。アカウント自動作成/self-botはしない。事前認証された許可済browser profiles・開発Activity・デプロイ先が必要。ない場合は該当gateをBLOCKED、作業者はそれ以外を進めてよいが全体完了不可。
- 性能測定はproduction build、Chromium同一環境、120秒trace＋10回reset/room reopen。desktop p95 frame<=20ms、CPU4倍slow mobile profile p95<=34ms、hidden復帰でNaNなし、GPU resource数が毎回初期値に戻る。これは実機thermal保証ではない。公開ロビーは実Chromium Lighthouseのmobile/desktop各3回中央値を保存し、アクセシビリティ100、重大違反0、残る性能課題は明示する。ゲームの動きを削って点数を稼がない。
- 各UIwaveは`/visual-qa`を実行して375/768/1280、default/focus/error/loading/reduced-motionを確認、CJK切れ0。基準画像は最初の実描画を独立レビューして承認後に保存し、現出力で無条件更新しない。
- QAに必要なSDK/App設定・許可済資格情報・外部サービスがないときは、何が未検証か・取得すべき環境を`docs/release-checklist.md`に残す。人間のクリックを合格条件にはせず、環境が整った後に同じagent-run suiteで合格させる。

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- W1 / S Phase1: 1–6、生命体とvisual gate。W2 / Phase2: 7–11、Jev sandbox。W3 / Phase3: 12–16、local round。W4 / Phase4: 17–23、multiplayer。W5 / Phase5: 24–28、editor。W6 / Phase6: 29–33、ending。W7 / Phase7: 34–39、Discord＋release。
- wave末のgateが通るまで次waveの製品実装は進めない。ただしcredentials準備・公式仕様照合・fixture設計は並行可能。各行のdependency優先、wave内でも同じファイルを別workerに同時編集させない。
- Collect: 5 read-only lanes（local inventory/Jev/Pixi/Discord/DO）完了。Verify: 親がJev Choice/models、DO WS/storage、Discord networking/instance一次資料を照合。Design: 本計画の契約へ反映。Adversarial: Metis session `ses_f46d5f925ffejv84p1y5vxFHS5`の指摘を取捨選択。Synthesize: 単一計画と下記DAG。サブエージェントの推奨を公式API仕様と誤認しない。

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 3,4 | 2 |
| 2 | — | 4 | 1,3 |
| 3 | 1 | 4 | 2 |
| 4 | 1,2,3 | 5 | — |
| 5 | 4 | 6 | — |
| 6 | 5 | 7 | — |
| 7 | 6 | 8,9 | — |
| 8 | 7 | 9 | — |
| 9 | 7,8 | 10,11 | — |
| 10 | 9 | 11 | — |
| 11 | 9,10 | 12,13 | — |
| 12 | 11 | 14,15 | 13 |
| 13 | 11 | 15 | 12,14 |
| 14 | 12 | 15 | 13 |
| 15 | 12,13,14 | 16 | — |
| 16 | 15 | 17,18 | — |
| 17 | 16 | 19,22 | 18 |
| 18 | 16 | 19 | 17,22 |
| 19 | 17,18 | 20 | 22 |
| 20 | 19 | 21 | 22 |
| 21 | 20,22 | 23 | — |
| 22 | 17 | 21,23 | 18,19,20 |
| 23 | 21,22 | 24,26,27 | — |
| 24 | 23 | 25,28 | 26,27 |
| 25 | 24 | 28 | 26,27 |
| 26 | 23 | 28 | 24,25,27 |
| 27 | 23 | 28 | 24,25,26 |
| 28 | 24,25,26,27 | 29,30,31 | — |
| 29 | 28 | 32 | 30,31 |
| 30 | 28 | 32 | 29,31 |
| 31 | 28 | 32 | 29,30 |
| 32 | 29,30,31 | 33 | — |
| 33 | 32 | 34,35,38 | — |
| 34 | 33 | 36 | 35,38 |
| 35 | 33 | 36 | 34,38 |
| 36 | 34,35 | 37,39 | 38 |
| 37 | 36 | 39 | 38 |
| 38 | 33 | 39 | 34,35,36,37 |
| 39 | 36,37,38 | F1–F4 | — |
| F1–F4 | 1–39 | handoff | 相互に並列 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. Bun workspaceと型・テスト実行基盤を作る
  What to do / Must NOT do: root `package.json,bun.lock,tsconfig.base.json,biome.json,bunfig.toml,playwright.config.ts,vitest.workers.config.ts`、apps/packagesのmanifest、`scripts/check-boundaries.ts`、`tests/unit/tooling.test.ts`を作成。全root scriptsをVerification strategyどおり定義。React runtime devtoolsはdev-onlyで準備、資格情報なしdefault mock。既存S/.codegraph/.omo/run-continuationを変更しない。Git初期化・remote作成・pushはしない。
  Parallelization: W1 | Blocked by: — | Blocks: 3,4 | 2と並行可。
  References: S:143-212,1184-1214,1403-1419; Architecture contract; C3。
  Acceptance criteria: `bun install --frozen-lockfile`、`bun run check`、`bun run test:unit -- tests/unit/tooling.test.ts`が成功。private workspace package間依存がDAG、Workersとbrowserのtsconfigを分離。
  QA happy: tooling testでschemaから推論した型と正常import graphを検証。failure: 同testのfixtureでcore→React import、secret公開prefix、0tests指定を拒否すること。両ケースのtestを実行し警告だけで終わらせない。
  Evidence: `<attemptDir>/task-1-happy.log`, `task-1-failure.log`, `task-1-red.log`。
  Commit: 条件付きY（Commit strategy参照） | `chore(workspace): establish strict game tooling`。

- [ ] 2. ゲームの視覚契約とprimitive状態一覧を定義する
  What to do / Must NOT do: `DESIGN.md`、`docs/design/references.md`、`docs/design/scene-contract.md`を作る。frontend skillのdesign/architecture/interactionと該当styleを読み、暖かい紙の舞台＋ゼリーの素材方向を採用。3案の比較はcreature silhouette/背景/ラベル配置で行い、dashboard方向は棄却。素材/色ramp/font/spacing/focus/loading/error/reduced-motionを固定。lazyweb/imagenは利用可能なら参考のみ、不可ならresearch logに未実施を明記、ゲームに画像生成依存を足さない。
  Parallelization: W1 | Blocked by: — | Blocks: 4 | 1,3と並行可。
  References: S:215-450,1371-1399; Visual and story contract; frontend skill `references/design/README.md`。
  Acceptance criteria: actor/attractor/text dock/result panelの状態表、375/768/1280 layout、6候補の重複回避、motion tokenと色覚・キーボード代替を文章/図で具体化。名前/確率バーはない。
  QA happy: 読み取り専用design reviewerがSとの対応表と全状態一覧を読んで、4人・6人・縦画面の配置可能性を確認。failure: 40grapheme候補6件＋200%拡大＋IMEキーボードの負荷ケースを図に当て、stage最小領域と入力dockが両立するか反証する。製品描画の最終合格はTask6で実画像確認。
  Evidence: `<attemptDir>/task-2-happy.md`, `task-2-failure.md`（参照・採否理由付き）。
  Commit: 条件付きY | `docs(design): define creature-first visual contract`。

- [ ] 3. 決定から姿勢を作る純粋な変形シミュレーションを作る
  What to do / Must NOT do: `packages/creature/src/{pose,contour,spring,attraction}.ts`と`tests/unit/creature/contour.test.ts`。64点の角度固定contour、面積補正、substep clamp、centroid/gazeを実装。乱数とclockは注入。PixiやReactを計算部にimportしない。
  Parallelization: W1 | Blocked by: 1 | Blocks: 4 | 2と並行可。
  References: S:303-417; Visual and story contractの数値初期値。
  Acceptance criteria: `bun run test:unit -- tests/unit/creature/contour.test.ts`。均等/単一優勢/二極/6方向の入力でfinite、自己交差0、面積±15%、方向の大小がlobeに対応。
  QA happy: fixed-seedの30/60/120fps相当のdt列で同時間の姿勢誤差<=2%restRadius、release2秒後速度減衰を検証。failure: 5秒のdt、NaN境界、0合計入力、不正choice数を与え暴走せず境界エラーまたは定義済neutralにする。
  Evidence: `<attemptDir>/task-3-happy.log`, `task-3-failure.log`, `task-3-poses.json`。
  Commit: 条件付きY | `feat(creature): add bounded spring contour simulation`。

- [ ] 4. Pixi meshとReact host・primitive showcaseを接続する
  What to do / Must NOT do: `packages/creature/src/render/{scene,mesh,materials,lifecycle}.ts`、`apps/web/src/game/CreatureStage.tsx`、`apps/web/src/dev/Showcase.tsx`、CSS token/primitives。P1非同期initのmount中断にも対応。texture/bufferは再利用、毎frame Graphics再構築やReact rerenderをしない。
  Parallelization: W1 | Blocked by: 1,2,3 | Blocks: 5。
  References: S:149-182,215-249; P1,P2; Task2 DESIGN.md; Architecture/Visual contracts。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/creature/renderer.spec.ts`でcanvas初期化、透明bodyの継目なし、showcaseのnormal/focus/error/loading状態とviewportを確認。
  QA happy: dev showcaseを375/768/1280で描画、body/surfaceのscreenshotとextract出力を比較。failure: React StrictMode mount/unmount10回とinit途中離脱でcanvas/ticker二重化0、WebGL init失敗はunsupported UI。
  Evidence: `<attemptDir>/task-4-happy.png`, `task-4-failure.log`, `task-4-resources.json`。
  Commit: 条件付きY | `feat(render): mount reusable Pixi creature scene`。

- [ ] 5. 顔・引力源・吸着と調整sandboxを作る
  What to do / Must NOT do: `packages/creature/src/render/{face,attractors,effects}.ts`、`apps/web/src/dev/CreatureLab.tsx`、`tests/e2e/creature/lab.spec.ts`。4候補sliderで調整し、2/6配置も切替可能。視線/瞬き/迷い/飽き/吸着を意味ある状態に対応。debug数字とtest hookはdev build限定、prototype段階からreduced-motionを実装。
  Parallelization: W1 | Blocked by: 4 | Blocks: 6。
  References: S:252-388,421-450,619-624,1275-1288; Visual contract。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/creature/lab.spec.ts`でA→B逆転、A/B拮抗、全候補均等、吸着直前の反転、reduced-motion更新が観測できる。
  QA happy: 3秒のattraction scriptを再生し、gazeと最大lobe方向をpose JSON＋動画で確認。failure: 動きを減らす設定でも新しい首位方向を表示、production buildで`/dev/creature`とslider APIを返さない。
  Evidence: `<attemptDir>/task-5-happy.webm`, `task-5-failure.png`, `task-5-poses.json`。
  Commit: 条件付きY | `feat(creature): add expressive face and attractor reactions`。

- [ ] 6. Phase1の見た目・動き・性能gateを通す
  What to do / Must NOT do: `tests/e2e/creature/quality.spec.ts`と`docs/design/creature-acceptance.md`。production相当sceneを120秒駆動しvisual-qaを実行。rest/weak/split/strong/reversal/finalの基準画像と動画をreviewし承認後固定。数値testだけで「可愛い/気持ちよい」を合格にしない。
  Parallelization: W1 | Blocked by: 5 | Blocks: 7。
  References: S:254-279,391-417,1271-1288; P2; DESIGN.md; Verification strategy。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/creature/quality.spec.ts`＋`/visual-qa`。frame budget達成、全state見分け可能、CJK候補切れ0。独立visual reviewerがSの柔らかさ/透過/表情/多方向伸びを画像・動画根拠で承認。
  QA happy: 4候補120秒と6候補30秒のframe trace、10reset資源数を採取。failure: hidden5秒→復帰/CPU4倍slow/resize中でjump暴走・白画面・残留tickerなし。不合格なら3–5を直し次wave禁止。
  Evidence: `<attemptDir>/task-6-happy.json`, `task-6-failure.webm`, `task-6-visual-review.md`。
  Commit: 条件付きY | `test(creature): lock visual and motion quality gate`。

- [ ] 7. AI境界schemaとMock provider契約を作る
  What to do / Must NOT do: `packages/protocol/src/{ids,decision,errors}.ts`、`packages/ai/src/{provider,mock-provider}.ts`、`tests/unit/ai/contract.test.ts`。内部branded IDsとfinite分布、envelope metadataとAPI bodyを分離。Mockはseeded scenario fixtureだけ、本番に暗黙選択しない。
  Parallelization: W2 | Blocked by: 6 | Blocks: 8,9。
  References: S:742-805,902-924; J1–J3; AI contract。
  Acceptance criteria: `bun run test:unit -- tests/unit/ai/contract.test.ts`。2/4/6choices、合法probabilities、sum normalization、model固定、confidence非エラーがparseされる。
  QA happy: 公開API形のfixtureをparseしてrenderer inputへ変換。failure: missing/extra choice・文字列数値・invalid sum・unknown model・spoof revisionをそれぞれ拒否。promptの文章一致snapshotは禁止。
  Evidence: `<attemptDir>/task-7-happy.log`, `task-7-failure.log`。
  Commit: 条件付きY | `feat(ai): define typed decision provider contract`。

- [ ] 8. 秘密鍵を隠すローカルJev gatewayと費用制限を作る
  What to do / Must NOT do: `apps/server/src/{index,dev-gateway,config}.ts`、`packages/ai/src/{jev-provider,http-policy,quota}.ts`、`tests/workers/ai-gateway.test.ts`。Hono local route→ky→TypeSafe、timeout/retry明示、day/game予約を外部送信前に行う。dev gatewayはlocalhost限定で本番未登録、remote accessを許可しない。
  Parallelization: W2 | Blocked by: 7 | Blocks: 9。schema確定後にadapterを実装。
  References: S:703-739,774-804,1108-1133; J1,J2,C3; AI budget contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/ai-gateway.test.ts`。fetch mockはHTTP wire境界だけ。正常応答と401/422非retry、429/529/5xx/timeouts最大1retry、Retry-Afterが締切超なら即失敗。
  QA happy: Workers経由でfixture分布を受け、送信ごとattempt増加。failure: missing daily config/secretで送信0、120上限超送信0、abort後遅延結果破棄、buildの公開assetにsecret不在。
  Evidence: `<attemptDir>/task-8-happy.log`, `task-8-failure.log`（headers/body原文は記録しない）。
  Commit: 条件付きY | `feat(ai): add budgeted server-side Jev gateway`。

- [ ] 9. Active Context・重複減衰・飢餓しない評価schedulerを作る
  What to do / Must NOT do: `packages/ai/src/{context,duplicates,scheduler,impact}.ts`、`tests/unit/ai/scheduling.test.ts`。AI contractのsingle-flight/cutoff/job token、未評価batchとrecent/high-impact選択を実装。inputSeq増加だけで有効な古いprefix応答を捨てない。
  Parallelization: W2 | Blocked by: 7,8 | Blocks: 10,11。
  References: S:596-625,808-924,971-984; AI/concurrency contract。
  Acceptance criteria: `bun run test:unit -- tests/unit/ai/scheduling.test.ts`。continuous dirtyでも1秒maxWaitで開始、pendingを取りこぼさずbounded、singleとgroup impactが区別される。
  QA happy: 6人burst→評価中追加→次評価をfake clockで追い、全accepted inputSeqがcutoffに入ること。failure: timeout済A→B適用→A遅着、reset/closed epoch、48pending/backpressure、byte budget超過を検証。静止stateで追加call0。
  Evidence: `<attemptDir>/task-9-happy.log`, `task-9-failure.log`, `task-9-timeline.json`。
  Commit: 条件付きY | `feat(ai): schedule bounded fair decision updates`。

- [ ] 10. 日本語Jev evalとモデル変更gateを用意する
  What to do / Must NOT do: `tests/jev-evals/ja-v1.json`、`scripts/eval-jev.ts`、`docs/ai-evaluation.md`、`tests/unit/ai/eval-runner.test.ts`。12ケース×3回、2/4/6択、甘党vs危険、罠の反論、世界観破壊、指示無視文、同義spam、拮抗を用意。syntheticのみ、期待値は手書きの方向/対照ペア、正確なprob固定は禁止。
  Parallelization: W2 | Blocked by: 9 | Blocks: 11。
  References: S:502-594,1218-1246; J2,J3; Verification strategy。
  Acceptance criteria: `bun run test:unit -- tests/unit/ai/eval-runner.test.ts`と`bun run eval:jev -- --suite ja-v1 --max-attempts 60`。schema success100%、12ケース中10以上が各2/3の期待方向を満たす、構造的system境界違反0、p95<=3000msを初期gate（SLAではない）。
  QA happy: 36評価のmanifestにmodel/request hash/latency/usage/aggregate verdictを記録。failure: fake HTTPで全失敗/上限/不明modelを与えて非zero終了、キーなしBLOCKEDがpassと区別される。live不合格をmockで埋めない。
  Evidence: `<attemptDir>/task-10-happy.json`, `task-10-failure.log`, `task-10-live.json`。
  Commit: 条件付きY | `test(ai): add Japanese behavior evaluation gate`。

- [ ] 11. 自由投稿→Jev→生命体のPhase2を完成する
  What to do / Must NOT do: `apps/web/src/dev/DecisionLab.tsx`、`tests/e2e/ai/decision-lab.spec.ts`。固定4択と自由文、予告反応/処理中/本反応/失敗を接続。ライブキーの入力欄は作らない。Task10を通った実APIで同じ操作を1回実行。
  Parallelization: W2 | Blocked by: 9,10 | Blocks: 12,13。
  References: S:926-951,1291-1299; AI/Visual contract。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/ai/decision-lab.spec.ts`で80ms以内予告・pending解除・分布に対応した変形。live eval evidenceがあり、実gatewayがmockと明示区別できる。
  QA happy: 「脱出艇にはプリン100個」→「それ政府の罠」を入れ、操作/response/poseの時系列を採取。failure: 3秒timeout中も描画継続、旧姿勢を保ち、エラー後の次投稿で回復。ユーザー向け画面にprob数字なし。
  Evidence: `<attemptDir>/task-11-happy.webm`, `task-11-failure.webm`, `task-11-live-receipt.json`。
  Commit: 条件付きY | `feat(sandbox): connect text decisions to creature motion`。

- [ ] 12. TURN/LIVEの純粋ルールと人数・枠公平性を実装する
  What to do / Must NOT do: `packages/game-core/src/{state,commands,reducer,turn,live,settings}.ts`、`tests/unit/game/rules.test.ts`。server/clock/AI effectは返り値のcommandとして分離。roster固定、rotation/pass、server deadline、capacity、noContestをunionで表す。
  Parallelization: W3 | Blocked by: 11 | Blocks: 14,15 | 13と並行可。
  References: S:452-498,954-1028,1301-1310; Game contract。
  Acceptance criteria: `bun run test:unit -- tests/unit/game/rules.test.ts`。2/4/6人×3ラウンドで同枠数、timeout pass、同user2投稿不可、1人はdevのみ、7人拒否。
  QA happy: seed固定で順序/round rotation、LIVE120秒の締切を検証。failure: 他人turn/締切と同時投稿/試合中設定変更/無資格startを拒否しstate不変。
  Evidence: `<attemptDir>/task-12-happy.log`, `task-12-failure.log`。
  Commit: 条件付きY | `feat(core): implement fair turn and live rules`。

- [ ] 13. 日本語IME対応入力と非数値のゲームHUDを作る
  What to do / Must NOT do: `apps/web/src/game/{InputDock,GameHud,MessageFeed}.tsx`、`packages/protocol/src/text.ts`、`tests/e2e/game/input.spec.ts`。composition中Enterは確定のみ、完了後Enter/送信buttonでsubmit。投稿者/担当/内容を公開し、aria-liveの発話量は最新eventに限定。
  Parallelization: W3 | Blocked by: 11 | Blocks: 15 | 12,14と並行可。
  References: S:452-495,1385-1399; input/visual contracts; Task2 DESIGN.md。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/game/input.spec.ts`。IME Enterで誤送信0、140grapheme境界、pending/ack表示、readonly turn表示、候補・faceが入力に隠れない。
  QA happy: 日本語composition eventと送信を実browserで駆動し1postのみ。failure: scriptタグ/長いURL/結合文字/空白だけ/二重clickを試しXSS0・重複0・適切なerror。
  Evidence: `<attemptDir>/task-13-happy.webm`, `task-13-failure.png`, `task-13-results.json`。
  Commit: 条件付きY | `feat(ui): add IME-safe party input and HUD`。

- [ ] 14. 最終評価・任意早期決着・障害時勝者なしを実装する
  What to do / Must NOT do: `packages/game-core/src/{settlement,early-decision,outcome}.ts`、`tests/unit/game/settlement.test.ts`。cutoff固定、settling8秒、dwell reset、終端priority、一意のoutcome、引分け/noContestを実装。host requestとroom closeを別commandにする。
  Parallelization: W3 | Blocked by: 12 | Blocks: 15 | 13と並行可。
  References: S:379-388,988-1000,1108-1133; Game/AI contracts。
  Acceptance criteria: `bun run test:unit -- tests/unit/game/settlement.test.ts`。119.999秒受理投稿が最終cutoffへ入り120秒投稿は拒否、成功時のみwinner、pending有り/timeoutではnoContest。
  QA happy: 通常turn完了とLIVE終了を各判定、cutoff既評価ならcall0。failure: 同時host/timer/dwell、未評価投稿によるdwell解除、8秒超・budget枯渇・引分け・late成功でoutcomeが変わらないこと。
  Evidence: `<attemptDir>/task-14-happy.log`, `task-14-failure.log`, `task-14-timeline.json`。
  Commit: 条件付きY | `feat(core): settle games without stale AI winners`。

- [ ] 15. 一画面ローカル試合とresetを統合する
  What to do / Must NOT do: `apps/web/src/local/{LocalSession,LocalGame}.tsx`、`tests/e2e/game/local-round.spec.ts`。同画面でseat交代するTURNとdev LIVE入力を接続、input→AI→core→creature→result→rematchを通す。resetはgameEpochを進め、未完了requestと演出をcancel。
  Parallelization: W3 | Blocked by: 12,13,14 | Blocks: 16。
  References: S:1301-1310; Tasks11–14; Game/AI contracts。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/game/local-round.spec.ts`で4人3round→winner表示→reset→再試合。結果に元scenario/選択肢/勝者またはnoContestを表示。
  QA happy: 規定投稿から吸着・結果を見て、再試合時quota/gameEpochが正しく新規。failure: AI待機中reset→旧応答、noContest→rematch、途中離脱で古い入力・poseが混ざらない。
  Evidence: `<attemptDir>/task-15-happy.webm`, `task-15-failure.log`。
  Commit: 条件付きY | `feat(local): complete playable single-screen rounds`。

- [ ] 16. Phase3のルール・操作・描画統合gateを通す
  What to do / Must NOT do: `tests/e2e/game/local-matrix.spec.ts`、`docs/game-rules.md`、`docs/decisions.md`。全初期調整値とownerの変更を転記、2/4/6人・TURN/LIVE・default/optionalの組合せを実際に動かす。調整した値は理由と新baselineを記録。
  Parallelization: W3 | Blocked by: 15 | Blocks: 17,18。
  References: S:954-1028,1301-1310,1457-1470; Game contract; Verification strategy。
  Acceptance criteria: `bun run test:unit -- tests/unit/game`＋`bun run test:e2e -- tests/e2e/game/local-matrix.spec.ts`＋`/visual-qa`。公平枠・終了・resetの欠落なし、short free textが中心で長文待ち画面にならない。
  QA happy: 6組合せを固定fixtureで完走し結果を独立fixture expected winnerと照合。failure: 各modeの接続相当AI失敗/文字超過/optional早期決着で、誤勝者・画面freezeがない。
  Evidence: `<attemptDir>/task-16-happy.json`, `task-16-failure.webm`, `task-16-visual-review.md`。
  Commit: 条件付きY | `test(game): verify local party game contracts`。

- [ ] 17. GameRoom DOの永続化・単一alarm・schema migrationを作る
  What to do / Must NOT do: `apps/server/src/rooms/{GameRoom,storage,schema,deadlines,recovery}.ts`、`apps/server/wrangler.jsonc`、`tests/workers/room-storage.test.ts`。C2に従いSQLite transactionでsnapshot+event+dedupeを更新、唯一のalarmを全deadlineの最小値へ設定。constructorは復旧だけ、AI fetchをblockConcurrencyWhile内に入れない。cursorはawait前に消費。
  Parallelization: W4 | Blocked by: 16 | Blocks: 19,22 | 18と並行可。
  References: S:186-209,902-924; C1–C3; Room contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/room-storage.test.ts`で実SQLiteを使用。再生成後に同gameEpoch/inputSeq/quota/deadlineが復旧、migration同version再実行はno-op。
  QA happy: commit→evict→loadで完全一致、due alarmを重複配送して終了1回。failure: transaction途中throwでack/broadcastされずrollback、constructorが既存alarmを上書きしない、不明schema versionをfail closed。
  Evidence: `<attemptDir>/task-17-happy.log`, `task-17-failure.log`。
  Commit: 条件付きY | `feat(server): persist authoritative room state`。

- [ ] 18. Browser招待・セッション・WS ticketの認可を作る
  What to do / Must NOT do: `apps/server/src/auth/{browser,invites,sessions,tickets,origin}.ts`、`packages/platform/src/{adapter,browser}.ts`、`tests/workers/browser-auth.test.ts`。opaque secret/hash、join/reconnect rotation、ticket single-use/30秒、Origin allowlist、payload境界を実装。ログイン/ユーザーDBやJWT長期refresh基盤を足さない。
  Parallelization: W4 | Blocked by: 16 | Blocks: 19 | 17,22と並行可。
  References: S:127-140,1137-1161,1347-1362; Room/auth contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/browser-auth.test.ts`。server-generated playerIdのみ有効、所有room以外のticketでjoin不可、7人目拒否、midgame joinは待機。
  QA happy: invite→join→ticket→upgrade→reconnect token rotation。failure: wrong/expired/reused ticket、旧reconnect token、偽host、cross-origin、fragment漏洩をテストし送信前に拒否/ログredact。
  Evidence: `<attemptDir>/task-18-happy.log`, `task-18-failure.log`。
  Commit: 条件付きY | `feat(auth): secure invitation-only browser sessions`。

- [ ] 19. versioned WS commandとsnapshot同期を接続する
  What to do / Must NOT do: `packages/protocol/src/{client-messages,server-messages,snapshot}.ts`、`apps/server/src/rooms/{transport,commands}.ts`、`apps/web/src/net/{client,sync}.ts`、`tests/workers/room-websocket.test.ts`。ctx.acceptWebSocketとattachmentを使用。指示の通し番号/command dedupe/expectedEpoch、snapshot再同期を実装。
  Parallelization: W4 | Blocked by: 17,18 | Blocks: 20 | 22と並行可。
  References: S:873-924,1314-1322; C1; protocol contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/room-websocket.test.ts`で実WebSocketPairを使い、4接続が同seq/phase/decisionを受ける。無効frameは規定error/close、state無変更。
  QA happy: 受理投稿にack1回・全員event1回、差分欠落→snapshot。failure: duplicate commandに元ackを再返却、same ID別payload拒否、16KiB超/protocol不一致/旧epoch/高頻度でbounded処理。
  Evidence: `<attemptDir>/task-19-happy.log`, `task-19-failure.log`, `task-19-protocol-trace.json`。
  Commit: 条件付きY | `feat(net): synchronize versioned room commands`。

- [ ] 20. 再接続・ホスト引継ぎ・全員不在pauseを実装する
  What to do / Must NOT do: `apps/server/src/rooms/{presence,host-election,leases}.ts`、`apps/web/src/net/reconnect.ts`、`tests/workers/room-presence.test.ts`、`tests/e2e/rooms/reconnect.spec.ts`。heartbeat15秒/lease45秒、host election、empty60秒pauseとresume、socket generation guard。reconnectは指数backoff250ms→4秒＋seeded jitter、room closedはretry停止。
  Parallelization: W4 | Blocked by: 19 | Blocks: 21 | 22と並行可。
  References: S:1316-1322; C1,C2; Room lifetime contract; owner「他の参加者へ引き継ぐ」。
  Acceptance criteria: `bun run test:workers -- tests/workers/room-presence.test.ts`＋`bun run test:e2e -- tests/e2e/rooms/reconnect.spec.ts`。旧host退出→最古接続者、復帰で奪回なし、全員不在時間分だけplaying期限延長。settling8秒と生成deadlineは延長しない。
  QA happy: 4browser contextのhost offline→引継ぎ→復帰でroster重複0。failure: silentネットワーク断、旧socket close遅着、2tab同seat、59秒復帰/60秒以降拒否、alarm遅延でもexpired判定。
  Evidence: `<attemptDir>/task-20-happy.webm`, `task-20-failure.log`, `task-20-presence.json`。
  Commit: 条件付きY | `feat(rooms): recover sessions and transfer host authority`。

- [ ] 21. ルーム閉鎖・全文削除・匿名集計を整合させる
  What to do / Must NOT do: `apps/server/src/rooms/{close,limits,aggregate-outbox}.ts`、`apps/server/src/control/{aggregates,receipts}.ts`、`tests/workers/room-deletion.test.ts`、`docs/privacy.md`。ControlPlane active mapping revoke、close epoch、socket/Blob破棄、deleteAll。数値outboxも閉鎖時破棄し、ControlPlane受理済の匿名数値と短命receiptだけ残す。Cloudflare PITRとAI provider保持条件を説明し永久履歴を作らない。
  Parallelization: W4 | Blocked by: 20,22 | Blocks: 23。
  References: S:808-838,1250-1266; C2; Room/lifetime contract; owner「ゲームプレイ中だけ」「シンプルな公開用集計」。
  Acceptance criteria: `bun run test:workers -- tests/workers/room-deletion.test.ts`。close/empty timeout後に旧URL/tokenから投稿・参加者・endingを読めない、全tableが削除、closed state再作成なし。公開payloadに識別子/本文0。
  QA happy: 完了2試合→duplicate aggregate submit→1回ずつ加算→room close→本文不可。failure: delete途中再起動、pendingAI/生成遅着、ControlPlane障害、24h後receipt再送、8MiB/20試合上限を検証。物理バックアップ削除をtest結果から推定しない。
  Evidence: `<attemptDir>/task-21-happy.log`, `task-21-failure.log`, `task-21-data-inventory.json`。
  Commit: 条件付きY | `feat(privacy): expire room content and retain anonymous totals`。

- [ ] 22. 複数ルーム共通のAI予算・server-authoritativeジョブを実装する
  What to do / Must NOT do: `apps/server/src/control/{ControlPlane,budgets,registry}.ts`、`apps/server/src/rooms/{decision-jobs,generation-slots}.ts`、`tests/workers/global-budget.test.ts`。原子的day reservation、game120 cap、118+2終端予約、生成前後各1枠、job token復旧を統合。外部attemptのat-most-onceを保証できない再起動ではreserved扱いのまま消費し、安全側に抑止。
  Parallelization: W4 | Blocked by: 17 | Blocks: 21,23 | 18,19,20と並行可。
  References: S:703-739,902-924,1108-1133; J1,J2,C2; AI budget contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/global-budget.test.ts`。複数DO同時予約でも日次cap超過0、121送信0、final2枠確保、日跨ぎに前日reservationを当日へ二重計上しない。
  QA happy: 10rooms並列でmock upstreamを呼びattempt数とquotaが一致。failure: reserve後crash・response喪失・retry-after長期・config未設定・予算サービス失敗でfail closed。day capはUIから変更不可。
  Evidence: `<attemptDir>/task-22-happy.log`, `task-22-failure.log`, `task-22-budget-ledger.json`。
  Commit: 条件付きY | `feat(budget): enforce cross-room AI attempt limits`。

- [ ] 23. Phase4の複数browser試合と復旧gateを通す
  What to do / Must NOT do: `tests/e2e/rooms/multiplayer.spec.ts`、`tests/workers/room-restart.test.ts`、`docs/protocol.md`。room routerに全core/AI/transportを統合。2/4/6contextsでTURN/LIVEを完走し、resumeとserver restartを現実に実行。課金provider負荷試験は禁止、upstream HTTP fixtureを使用。
  Parallelization: W4 | Blocked by: 21,22 | Blocks: 24,26,27。
  References: S:873-924,1314-1324; C1–C3; Tasks17–22。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/rooms/multiplayer.spec.ts`＋`bun run test:workers -- tests/workers/room-restart.test.ts`。全参加者のwinner/gameEpoch/revision一致、再起動後同ゲームから続行、本文削除まで完走。
  QA happy: 6人LIVEと4人TURN、各client到着順差を吸収。failure: 1client packet loss・server再生成・host退出・last input pending→timeupでも最終cutoff保証、freeze/誤勝者/二重集計なし。
  Evidence: `<attemptDir>/task-23-happy.json`, `task-23-failure.webm`, `task-23-restart.log`。
  Commit: 条件付きY | `test(multiplayer): verify synchronized recoverable games`。

- [ ] 24. ホスト用ロビー・シナリオ・人数連動選択肢editorを作る
  What to do / Must NOT do: `apps/web/src/lobby/{Lobby,ScenarioEditor,ChoiceEditor,Roster}.tsx`、`apps/server/src/rooms/lobby.ts`、`tests/e2e/lobby/editor.spec.ts`。シナリオ/選択肢の手動編集、担当公開、ready/startを実装。人数減少時は既存入力を勝手に消さずorphan draftとしてルーム中保持し、開始時に有効人数分だけ確定。
  Parallelization: W5 | Blocked by: 23 | Blocks: 25,28 | 26,27と並行可。
  References: S:628-659,1003-1028,1325-1333; Game/input contract; DESIGN.md。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/lobby/editor.spec.ts`。2→6→4人で有効choice欄が連動、2人以上/全員ready/空欄なし/choice distinctでのみstart。
  QA happy: 4人scenario/choicesをホストが編集し全員のロビーに同revision反映。failure: 非host edit・同時join/edit・空欄/重複/長文・旧lobbyRevisionを拒否して手入力を保持。
  Evidence: `<attemptDir>/task-24-happy.png`, `task-24-failure.webm`。
  Commit: 条件付きY | `feat(lobby): add editable shared game setup`。

- [ ] 25. 一回だけの選択肢生成と手入力保護を作る
  What to do / Must NOT do: `packages/ai/src/{generative-provider,workers-ai-provider,choice-generation}.ts`、`apps/server/src/rooms/generate-choices.ts`、`tests/workers/choice-generation.test.ts`、`tests/e2e/lobby/generation.spec.ts`。クリック時のみ人数分の短い異種候補をschema付きで生成、lobbyRevisionをcaptureし変更済フォームへ自動上書きしない（提案として明示適用）。
  Parallelization: W5 | Blocked by: 24 | Blocks: 28 | 26,27と並行可。
  References: S:661-739; G1; AI generation/budget contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/choice-generation.test.ts`＋`bun run test:e2e -- tests/e2e/lobby/generation.spec.ts`。counts exactly roster、各40grapheme、失敗時手動で続行、double clickで1attempt。
  QA happy: 合法JSON→4欄へ挿入→ホストが修正。failure: invalid JSON/timeout/人数変化/入力編集/room close遅着で上書き0、retry自動発火0、slot消費後buttonは再生成不可。
  Evidence: `<attemptDir>/task-25-happy.webm`, `task-25-failure.log`。
  Commit: 条件付きY | `feat(ai): generate editable choices once per game`。

- [ ] 26. モード・終了設定とゲーム前合意表示を作る
  What to do / Must NOT do: `apps/web/src/lobby/GameSettings.tsx`、`apps/server/src/rooms/settings.ts`、`tests/e2e/lobby/settings.spec.ts`。TURN rounds/turn time、LIVE duration、earlyDecision/hostDecisionを契約の選択値でUI化。公平性を外す設定は全員へ表示し、変更時readyを解除。開始後は変更不可。
  Parallelization: W5 | Blocked by: 23 | Blocks: 28 | 24,25,27と並行可。
  References: S:954-1000; Game contract; owner公平性優先。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/lobby/settings.spec.ts`。初期TURN3×20秒/LIVE120秒、optional off。server schema外の数値をreject。
  QA happy: ホストがLIVE60秒へ変更し全員のready解除・表示一致、再ready後開始。failure: 非host/進行中更新/早期終了offで強制commandを送っても発動しない。
  Evidence: `<attemptDir>/task-26-happy.png`, `task-26-failure.log`。
  Commit: 条件付きY | `feat(settings): expose agreed party game rules`。

- [ ] 27. ロビーとゲームのresponsive・アクセシビリティを仕上げる
  What to do / Must NOT do: `apps/web/src/ui/{Button,TextField,Dialog,Status}.tsx`、`apps/web/src/styles/responsive.css`、`tests/e2e/ui/accessibility.spec.ts`。既存primitiveを拡張、dialog focus/keyboard、status alternative、200%zoom、long text、virtual keyboard、reduced motionに対応。情報を隠してlayoutを成立させない。
  Parallelization: W5 | Blocked by: 23 | Blocks: 28 | 24,25,26と並行可（primitive編集所有者を固定）。
  References: S:215-249,1141-1150,1371-1399; Visual contract; DESIGN.md。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/ui/accessibility.spec.ts`。375/768/1280で水平overflow0、axe serious/critical0、全操作keyboard可能、6候補識別が色依存でない。
  QA happy: キーボードだけで入力・送信・設定・退出confirm、canvasの非数値代替状態が更新。failure: 360px＋200%zoom＋長文候補＋IME、reduced motionに切替ても入力と判断表示が使える。
  Evidence: `<attemptDir>/task-27-happy.png`, `task-27-failure.png`, `task-27-axe.json`。
  Commit: 条件付きY | `feat(a11y): support responsive accessible party controls`。

- [ ] 28. Phase5の作成→招待→編集→対戦gateを通す
  What to do / Must NOT do: `tests/e2e/lobby/full-flow.spec.ts`、`docs/hosting.md`。新規room→link join→manualまたは1生成→settings→ready→試合を一貫検証。ユーザーにdeveloper console操作を要求しない。初期AI unavailableでも手動設定は機能する。
  Parallelization: W5 | Blocked by: 24,25,26,27 | Blocks: 29,30,31。
  References: S:628-739,1325-1333; Tasks24–27; Verification strategy。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/lobby/full-flow.spec.ts`＋`/visual-qa`。招待fragmentは交換後historyから消え、display names安全、全設定がserver authoritative。
  QA happy: manualとgeneratedの両経路で4人TURN完走。failure: 生成中host転送・participant変更・invite不正・設定競合でも入力保持、権限更新、再ready後安全に開始。
  Evidence: `<attemptDir>/task-28-happy.webm`, `task-28-failure.log`, `task-28-visual-review.md`。
  Commit: 条件付きY | `test(lobby): validate complete hosted party setup`。

- [ ] 29. 紙芝居用の重要イベントを決定的に抽出する
  What to do / Must NOT do: `packages/game-core/src/story/{highlights,panels,templates}.ts`、`tests/unit/story/highlights.test.ts`。開始/逆転/impact/終盤/結果からeventId参照で3〜5panel選択、同点はseqが早い方。single/groupを保持しclaimは引用と区別。全ログを生成providerへ渡さない。
  Parallelization: W6 | Blocked by: 28 | Blocks: 32 | 30,31と並行可。
  References: S:842-870,1031-1080; Story contract。
  Acceptance criteria: `bun run test:unit -- tests/unit/story/highlights.test.ts`。group決定打を個人の功績にしない、winner/noContestとcaption template一致、イベント不足でも3panelが成立する。
  QA happy: 逆転2回＋group1回の既知timelineからexpected eventIdsを選出。failure: 0投稿/引分け/noContest/同率impact/長文claimで新しい事実や勝者を捏造せず、上限内templateを返す。
  Evidence: `<attemptDir>/task-29-happy.log`, `task-29-failure.log`, `task-29-panels.json`。
  Commit: 条件付きY | `feat(story): extract factual match highlights`。

- [ ] 30. 同期可能なpose snapshotとCanvas画像再利用を作る
  What to do / Must NOT do: `packages/creature/src/{snapshot,replay-pose,extract}.ts`、`tests/e2e/story/snapshots.spec.ts`。server decision event＋seedからcanonical poseを再構成、通常clientは手元poseも一時キャプチャ、reconnect者はcanonicalで同eventを表示。extract.canvasを使いBlob化、eventId最大5枚を保持しresults破棄時release。画像はサーバーに送らない。
  Parallelization: W6 | Blocked by: 28 | Blocks: 32 | 29,31と並行可。
  References: S:1084-1105; P1,P2; Visual/story contract。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/story/snapshots.spec.ts`。新規clientでもsame event/choice/seedを再描画、empty screenshot0、debug情報0、pose version不一致にtemplate illustration fallback。
  QA happy: start/reversal/finalを保存してreload相当clientで再表示。failure: WebGL context loss/texture dispose/6候補長文/rendererVersion不明で勝者を変えず、Blobとtextureの残留0。
  Evidence: `<attemptDir>/task-30-happy.png`, `task-30-failure.log`, `task-30-pose.json`。
  Commit: 条件付きY | `feat(story): capture and reconstruct gameplay illustrations`。

- [ ] 31. 終了時一回生成と失敗時templateを作る
  What to do / Must NOT do: `packages/ai/src/ending-generation.ts`、`apps/server/src/rooms/generate-ending.ts`、`tests/workers/ending-generation.test.ts`、`scripts/eval-generation.ts`。構造化eventsのみからtitle/captionをG1で生成、eventId allowlist/文字数をparse。winnerはサーバー確定ラベルから描画しモデルには変更させない。任意の再生成buttonを足さない。
  Parallelization: W6 | Blocked by: 28 | Blocks: 32 | 29,30と並行可（共通panel schemaを開始時固定）。
  References: S:703-739,1031-1133; G1; AI/story contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/ending-generation.test.ts`＋`bun run eval:generation -- --suite ending-ja --max-attempts 2`。実モデルが日本語schemaを出すことを2 synthetic gamesで確認（失敗はtemplateになることも検証）、default CIはwire fixture。
  QA happy: valid structured responseが元eventId順でcaptionに適用、結果はserver winnerのまま。failure: malformed JSON/未知event/固有名詞追加/timeout/duplicate ending event/closed room遅着でtemplateへ一度だけfallback、追加生成call0。
  Evidence: `<attemptDir>/task-31-happy.log`, `task-31-failure.log`, `task-31-live.json`。自動prose判定ではなくschema＋独立caption読解レビューで内容忠実性を確認。
  Commit: 条件付きY | `feat(story): generate bounded ending captions with fallback`。

- [ ] 32. 全員で振り返るリザルトと紙芝居UIを統合する
  What to do / Must NOT do: `apps/web/src/results/{Results,Kamishibai,Panel}.tsx`、`apps/server/src/rooms/ending.ts`、`tests/e2e/story/results.spec.ts`。即結果表示→caption pending→生成またはtemplate、全員同じpanel集合、各自のページ送り（ホスト同期強制なし）、rematch準備、closeRoom確認。download/share archive機能は追加しない。
  Parallelization: W6 | Blocked by: 29,30,31 | Blocks: 33。
  References: S:1031-1133,1335-1339,1482-1537; Story/lifetime contract。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/story/results.spec.ts`。4clientsに同じpanel/eventId/titleが届き、遅い生成でも結果とページ送りが使える。
  QA happy: 逆転のある試合→5panel→rematchで新gameと旧storyを混ぜない。failure: ending中reconnect/host交代/生成失敗/room closeで本文・Blob消去、終了済みgameへlate captionを書き込まない。
  Evidence: `<attemptDir>/task-32-happy.webm`, `task-32-failure.log`。
  Commit: 条件付きY | `feat(results): share a concise gameplay picture story`。

- [ ] 33. Phase6の紙芝居の忠実性・寿命・費用gateを通す
  What to do / Must NOT do: `tests/e2e/story/full-ending.spec.ts`、`tests/workers/story-lifecycle.test.ts`、`docs/story-contract.md`。4人の人間投稿が主役であること、本文保存終了、通常LLM前後2枠を検証。面白さをLLMの長文に肩代わりさせない。
  Parallelization: W6 | Blocked by: 32 | Blocks: 34,35,38。
  References: S:80-103,703-739,1031-1133; Tasks29–32。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/story/full-ending.spec.ts`＋`bun run test:workers -- tests/workers/story-lifecycle.test.ts`＋`/visual-qa`。事実/引用の対応、normal generation call<=2/game、closing後content不達。
  QA happy: manual choicesならpost1callのみ、generated choicesなら合計2call。failure: 生成provider全停止でtemplate story完走、outcomeは不変、closed roomと旧inviteからstory再取得不可。reviewerがpanelごと元eventを確認。
  Evidence: `<attemptDir>/task-33-happy.json`, `task-33-failure.webm`, `task-33-fidelity-review.md`。
  Commit: 条件付きY | `test(story): verify truthful ephemeral endings`。

- [ ] 34. Discord platform adapterと起動・招待・SDK寿命を実装する
  What to do / Must NOT do: `packages/platform/src/{discord,discord-errors,discord-layout}.ts`、`apps/web/src/platform/bootstrap.ts`、`tests/e2e/discord/adapter.spec.ts`。明示platform設定でBrowser/Discordを選択、iframe検出だけで決めない。ready/authorize/authenticate、participant/layout subscription cleanup、shareLinkをadapterへ隔離。権限の真偽判定はserverへ。
  Parallelization: W7 | Blocked by: 33 | Blocks: 36 | 35,38と並行可。
  References: S:107-140,1137-1181,1341-1345; D1,D2,D4; Platform/auth contract。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/discord/adapter.spec.ts`。SDK fake transportでinit順序/失敗/subscribe解除を観測し、Browser buildでSDKなしでもゲームが動く。
  QA happy: ready→authorize→server exchange→authenticate→verified room snapshot。failure: SDK unavailable/denied OAuth/INVALID_COMMAND/旧layout eventで説明と再試行可能、ゲームcoreにDiscord importなし。
  Evidence: `<attemptDir>/task-34-happy.log`, `task-34-failure.png`。
  Commit: 条件付きY | `feat(discord): isolate activity platform integration`。

- [ ] 35. Discord OAuth・本人確認・instance参加認可を実装する
  What to do / Must NOT do: `apps/server/src/auth/{discord-oauth,discord-membership,discord-session}.ts`、`tests/workers/discord-auth.test.ts`。最小identify scope、code exchange→user identity→Activity usersの一致、active mapping→room sessionを実装。body size/origin/session binding/state nonceを検証。必要ないguilds scopeや自己申告usernameを信頼しない。
  Parallelization: W7 | Blocked by: 33 | Blocks: 36 | 34,38と並行可。
  References: S:1137-1161; D1,D2,D3; Room/auth contract。
  Acceptance criteria: `bun run test:workers -- tests/workers/discord-auth.test.ts`。同instanceの2認証userだけが同room、異instanceは別room、同Discord userはsame seatで同時socket置換。
  QA happy: official wire response fixtureをserver経由でparseしてmembership確認。failure: 他application/存在しないinstance/本人不一致/users不在/expired token/code replay/API429でfail closedまたはbounded retry、未検証room作成0、token log0。
  Evidence: `<attemptDir>/task-35-happy.log`, `task-35-failure.log`。
  Commit: 条件付きY | `feat(discord-auth): verify activity identity and membership`。

- [ ] 36. Web配信とDiscord proxy経由API/WSを通す
  What to do / Must NOT do: `apps/server/wrangler.jsonc`のenv local/staging/production、Workers Static AssetsからWeb配信、`apps/web/src/net/urls.ts`、`docs/discord-setup.md`、`tests/e2e/discord/proxy.spec.ts`。Portal mappingは`/api`→同Worker、`/`→同Worker（longest first）、WSは同originの`/api/rooms/:id/ws`。self-host fonts/assets、hashed chunks、Hono API fallbackとSPA fallbackを分離。patchUrlMappingsは不要なら使わない。
  Parallelization: W7 | Blocked by: 34,35 | Blocks: 37,39 | 38と並行可。
  References: S:111-140,1137-1161; C1,C3,D3,D4; Auth/protocol contract。
  Acceptance criteria: `bun run build`、`bun run test:e2e -- tests/e2e/discord/proxy.spec.ts`、`bun run deploy:staging`。staging env/secretがなければdeployはBLOCKED、本番へ代替deploy禁止。real proxy pathでHTTPS/API/WSが動く。
  QA happy: mapped URL経由起動→API→WS101→join、asset再取得でhash一致。failure: unmapped external URL/CSP拒否・wrong Origin・API404をHTML200にしない・旧chunk切れ・deploy切断→reconnectを検証。
  Evidence: `<attemptDir>/task-36-happy-network.json`, `task-36-failure.log`, `task-36-staging-receipt.json`。
  Commit: 条件付きY | `feat(deploy): serve game through Discord-compatible proxy paths`。

- [ ] 37. Discordの画面・実4人参加・再認証gateを通す
  What to do / Must NOT do: `tests/discord-live/party-four.spec.ts`、`tests/e2e/discord/layout.spec.ts`、`docs/discord-qa.md`。safe areas/PIP/grid/rotation/keyboard/thermal通知時のeffects縮小、SDK timeoutを仕上げる。4許可済profilesでActivityを操作するlive runnerを作る。モックを実Activity証拠と呼ばない。
  Parallelization: W7 | Blocked by: 36 | Blocks: 39 | 38と並行可。
  References: S:1141-1150,1484-1535; D1–D4; Verification strategy。
  Acceptance criteria: `bun run test:e2e -- tests/e2e/discord/layout.spec.ts`＋`bun run test:discord:live -- --scenario party-four`＋`/visual-qa`。4人same instance、join/invite、TURN/LIVE、host transfer、endingがreal Discord上で完走。実環境不足時はrelease BLOCKED。
  QA happy: 事前認証browser profilesでreal mapped Activityを起動し4人同結果まで操作、session tokenは証跡に出さない。failure: 1人再認証/他instance join/host退出/アプリ最小化/縦画面keyboardでも権限逸脱や入力切れなし。physical mobile未検証は明記。
  Evidence: `<attemptDir>/task-37-happy.webm`, `task-37-failure.log`, `task-37-live-manifest.json`, `task-37-visual-review.md`。
  Commit: 条件付きY | `test(discord): validate real activity party sessions`。

- [ ] 38. 公開匿名集計・最小運用ログ・CIと運用資料を完成する
  What to do / Must NOT do: `apps/server/src/routes/stats.ts`、`apps/web/src/info/Stats.tsx`（ロビーfooterから小さく開く）、`apps/server/src/observability.ts`、`.github/workflows/ci.yml`、`docs/{operations,privacy,release-checklist}.md`、`README.md`、`tests/workers/public-stats.test.ts`。stats本文は総完了試合/投稿/平均時間のみ、20件未満pending。ログはeventCode/modelVersion/latencyBucket/errorKind/usageのみ、request本文・user/room ID・URL query・tokenを出さない。
  Parallelization: W7 | Blocked by: 33 | Blocks: 39 | 34–37と並行可。
  References: S:1250-1266,1347-1362,1403-1419; Lifetime/privacy/budget contracts。
  Acceptance criteria: `bun run test:workers -- tests/workers/public-stats.test.ts`、`bun run check`、`bun run test:unit`、`bun run test:workers`、`bun run test:e2e`をCIでdefault実行。live credential jobsは別workflow/manual dispatchで必須release gateの結果を参照。READMEはsetup/mock/live/staging/rollback/deletion/limitsを記載。
  QA happy: 20 synthetic completionsの翌日public countersが期待値、closed room削除後もglobal totalsのみ残る。failure: 19件以下、duplicate receipt、clientから直接increment、悪意本文/secretを含むerrorで個人情報が公開/logへ混入しない。
  Evidence: `<attemptDir>/task-38-happy.json`, `task-38-failure.log`, `task-38-ci.json`。
  Commit: 条件付きY | `feat(ops): publish minimal anonymous totals and release checks`。

- [ ] 39. 全7段階の統合・負荷・削除・リリース証拠を揃える
  What to do / Must NOT do: `tests/e2e/release/full-game.spec.ts`、`tests/workers/release-chaos.test.ts`、`docs/release-checklist.md`の実行結果欄。全成果をproduction相当でまとめて測定、mock/test hooks/devtoolsを取り除いたbundleも検査。結果のない項目を完了checkにしない。
  Parallelization: W7 | Blocked by: 36,37,38 | Blocks: F1–F4。
  References: S全48章、特に1271-1367,1457-1478; 全契約/Verification strategy; Tasks1–38 evidence。
  Acceptance criteria: `bun run check`＋`bun run build`＋`bun run test:unit`＋`bun run test:workers`＋`bun run test:e2e -- tests/e2e/release/full-game.spec.ts`＋`bun run test:workers -- tests/workers/release-chaos.test.ts`。real AI/Discord gate receiptsが存在しmodel/deployment version一致、正常/失敗両パス完了。
  QA happy: 10rooms×6clients mock upstreamで120秒、全room一致・p95 ack<=500msのlocal参考値・frame budget・120call capを確認、WebとDiscordで最後のプリンfixture→紙芝居→閉鎖削除。failure: network断/AI429/timeout/redeploy/budget0/close中late response/6人IME入力を同時に再現してデータ漏洩0、noContestが明確。
  Evidence: `<attemptDir>/task-39-happy.json`, `task-39-failure.log`, `task-39-release-manifest.json`（各gateへの相対パス・version・コマンド・exit code・test count）。
  Commit: 条件付きY | `test(release): prove complete invitation-only YURAGOO experience`。

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
  References: 本計画全契約、S全48章、Task39 manifest。Acceptance criteria: 39/39実装taskと7/7phaseの証拠が揃い未説明の差分0。Parallelization: Final | Blocked by: 1–39 | Blocks: handoff | F2,F3,F4と並行。
  Scope: 読み取り専用verifierが39taskの成果とSの48章・owner変更を対応表で確認。各gateの実コマンド/test count/exit code/artifactを追い、自己申告の完了欄だけを信じない。
  QA happy: `task-39-release-manifest.json`から全phase正常/異常evidenceを辿る。failure: live receipts欠落・test0件・skipを故意に入れたmanifest fixtureをrejectできること。Evidence: `<attemptDir>/F1-compliance.md`。Commit: N。全39task後、F2–F4と並列。
- [ ] F2. Code quality review
  References: Architecture/AI/Room contracts、Tasks1,7–10,17–23,35,38。Acceptance criteria: check/build/unit/workers成功、HIGH以上未解決欠陥0。Parallelization: Final | Blocked by: 1–39 | Blocks: handoff | F1,F3,F4と並行。
  Scope: 独立verifierが `bun run check && bun run build && bun run test:unit && bun run test:workers`を実行し、strict型/LOC/境界/取消/予算/SQL/認可をreview。認証・削除raceの実testを再実行、外部データがHTML/system instructionへ昇格しないことを確認。
  QA happy: 全suite成功とtraceの整合。failure: unauthorized host、旧epoch、上限超過、room delete後遅着caseを選択実行し拒否を確認。Evidence: `<attemptDir>/F2-quality.md`, `F2-tests.log`。Commit: N。
- [ ] F3. Real manual QA
  References: Visual/story contract、Verification strategy、Tasks6,16,23,28,33,37,39。Acceptance criteria: fresh Web/Discord成功証拠とvisual-qa承認、blocker/CJK clipping/操作不能0。Parallelization: Final | Blocked by: 1–39 | Blocks: handoff | F1,F2,F4と並行。
  Scope: **agentが実UIを操作するmanual QA**。Playwright＋visual-qaで375/768/1280のロビー/ゲーム/紙芝居を再操作。real staged Webとreal Discordの許可済profilesを使い、AI判断→身体→結果を確認。human eyeballを完了条件にしない。
  QA happy: `bun run test:e2e -- tests/e2e/release/full-game.spec.ts`とlive Discord runnerをfresh evidenceで再実行。failure: offline/reconnect、Jev unavailable、gen invalid、room close、reduced-motion、CJK長文を操作し独立visual reviewerが動画/画像を判定。Evidence: `<attemptDir>/F3-qa.md`, `F3-web.webm`, `F3-discord.webm`。Commit: N。資格情報がないならBLOCKED。
- [ ] F4. Scope fidelity
  References: Scope/Must NOT have、S:1347-1367、approved owner decisions、Task21 data inventory。Acceptance criteria: 禁止機能・無断保存・無関係変更0、承認scope欠落0。Parallelization: Final | Blocked by: 1–39 | Blocks: handoff | F1,F2,F3と並行。
  Scope: S原本・事前ファイル一覧・本計画と実ファイル差分を照合。名前付け/数値UI/ゲーム中LLM/長期履歴/個人ranking/勝手な公開配信がないこと、全7段階を省略していないことを確認。既存`.codegraph/`と`.omo/run-continuation/`への変更を除外する。
  QA happy: public bundle/API/画面と保存データinventoryを調査。failure: archive endpoint、secret leak、dev slider、AI fake勝者、mockのlive詐称を負例checklistにして実経路で不在を確認。Evidence: `<attemptDir>/F4-scope.md`。Commit: N。

## Commit strategy
- 現在はGit repositoryではない。**この計画だけを根拠にgit init/remote作成/commit/push/PR/公開deployを自動実行しない**。workerが既存repoを利用でき、ユーザーがbranch/PR作業を開始した場合だけtask-owned worktreeで各todoのcommitを作る。それ以外はファイル成果とevidenceで進捗を管理し、Commit行は提案messageとして残す。
- 1todo＝実装＋testのatomic commit。生成lockfile/必要schemaは同commit。無関係なユーザー編集をstageしない。S原本と既存metadataを保持。型/lint/test失敗の状態でcommitを完了扱いにしない。
- 各waveのgate通過時に変更ファイル一覧とevidenceをまとめる。性能/視覚の調整は対応test/baselineの承認を同commitで記録、screenshot一括更新だけのcommitは禁止。
- 実装の重大変更後は`/review-work`、UI変更後は`/visual-qa`。レビューが未完了ならPR handoffしない。
- rollbackは直前の検証済Workers deploymentへ戻すが、room schema非互換なdowngradeをしない。migration互換がない場合は新room受付停止→既存room終了/削除→deploy。本文を救出して長期保存するrollbackはしない。

### Prerequisites and explicit blocked states
- 必要tool: Bun、Node LTS（Wrangler/Vitest/Playwright用）、browser dependencies、Cloudflare Workers/DOの利用可能アカウント、TypeSafe key、Discord applicationとBot secret、許可済live profiles。versionはTask1/36でlockし記録。
- provider key/日次cap不足ではlive呼び出し0。Discord app設定不足はlive BLOCKED。Workerは模擬testを進めてよいがTask10/11/31/36/37/39/F3を未検証のまま完了宣言しない。
- プラン作成時点で上記実接続/性能/動作品質は**未実行**。この文書は成果物ではなく、成果を作って証明する手順。

## Success criteria
- 2〜6人の招待制Web/Discordで、公開担当を持ち、短い自由文で名のない生命体の意思と身体が変わり、TURN/LIVEが正しい最終cutoffで決着する。
- 非数値の柔らかい身体が均等/拮抗/逆転/強い決断を伝え、Phase1のvisual/motion gateと全画面CJK/responsive/a11y検証を通過。
- 通常LLMは試合前後各1試行以内、Jev<=120試行、日次capの競合試験成功。日本語Jevと終了生成のlive gateを通り、障害は明示的noContest/templateで扱う。
- 再接続・hibernation・再起動・ホスト転送で状態/予算/結果が壊れない。終端後に古いAI結果が勝者や削除済み本文を復活させない。
- 紙芝居は実eventと対応し、本文・個人情報はroom寿命で論理削除、公開には遅延した匿名global totalsだけが残る。バックアップ/provider保持の限界を告知。
- 全39todoが正常/異常QA証拠付きで完了しF1–F4全員APPROVE。結果をユーザーへ提示し、明示了承後に実装完了とする。BLOCKEDや未実測をpassに変更しない。
