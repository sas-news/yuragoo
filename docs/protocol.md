# Yuragoo ルーム・ワイヤプロトコル

この文書は、ブラウザクライアントとサーバ（Cloudflare Workers + Durable Object
`GameRoom`）の間で実際にやり取りされるプロトコルを、実装どおりに記述したものです。
対象コードは `packages/protocol`（エンベロープ定義）、`apps/server/src/rooms/*`
（DO 側の実装）、`apps/web/src/net/*`（クライアント側の実装）です。

- プロトコルバージョン: `protocolVersion = 1`（`packages/protocol/src/index.ts`）
- スキーマバージョン: `schemaVersion = 1`
- 転送: 1 ルーム = 1 Durable Object。リアルタイム通信は WebSocket、
  認証系は HTTPS POST。フレームはすべて JSON テキスト（バイナリ不可）。

---

## 1. HTTP 認証・接続フロー

WebSocket を開くまでの一連の HTTP 呼び出しは以下のとおりです。
いずれも `POST`（`GET` は `/api/rooms/:id/ws` と `/api/stats` のみ）、
JSON ボディ、上限 4KiB（`BODY_LIMIT_BYTES`）です。
`Origin` ヘッダは `originAllowed` で検査され、許可されない Origin は
`403 forbidden-origin` になります。

### 1.1 `POST /api/rooms` — ルーム作成

- ボディ: `{}`（ペイロードなし）
- 応答: `{ roomId, inviteSecret, inviteUrl }`
- `inviteSecret` が生で返るのはこの応答だけです。以後サーバは
  SHA-256 ハッシュのみを保持します。
- `roomId` は DO の `newUniqueId()`。以後のパス・`gameId` に使います。

### 1.2 `POST /api/rooms/:id/join` — 参加

- ボディ: `{ inviteSecret, displayName? }`
- 応答: `{ playerId, sessionToken, reconnectToken, lobbyWaiting }`
- エラー: `unknown-room`(404), `bad-invite`, `room-full`, `room-closed`,
  `room-expired`, `invalid-request`(422)
- ボディに書かれた `playerId`・host フラグは読まれません。
  席は DO が採番します（`joinOrder`）。

### 1.3 `POST /api/rooms/:id/ticket` — WS チケット発行

- ボディ: `{ sessionToken }`
- 応答: `{ ticket, expiresInSec }`
- エラー: `bad-session`, `room-closed`, `room-expired`
- チケットは単回使用・短寿命です。サーバはハッシュのみ保持し、
  アップグレード時にアトミックに消費します。

### 1.4 `POST /api/rooms/:id/reconnect` — 再接続（資格ローテーション）

- ボディ: `{ reconnectToken }`
- 応答: `{ playerId, sessionToken, reconnectToken }`
- エラー: `bad-reconnect`, `room-closed`, `room-expired`
- 呼ぶたびに `sessionToken`/`reconnectToken` がローテーションされます。
  古いトークンは失効するので、クライアントは応答を保持し直します。

### 1.5 `GET /api/rooms/:id/ws?ticket=...` — WebSocket アップグレード

- `Upgrade: websocket` 必須（無ければ `426 upgrade-required`）。
- `ticket` 欠落・不正は `401 bad-ticket`/`401 unauthorized`。
- 消滅済みルームは `410 room-gone`（`room-expired`/`room-closed`）で、
  クライアントはリトライを打ち切ります。
- 成功すると `101` でソケットを返し、DO が `{ playerId, socketGeneration }`
  のアタッチメントを付けて `acceptWebSocket` します。
  **このアタッチメントがクライアント identity の唯一の根拠**です。
  以後のコマンドでペイロードに書かれた `playerId` は一切信頼されません。
- 同一 `playerId` の旧ソケットは `1000 "replaced"` で閉じられ、
  `socketGeneration` が小さい側だけが切られます。

### 1.6 `GET /api/stats` — 公開集計（任意）

- 公開用の匿名集計（`ControlPlane.publicStats`）。完了ゲームが
  しきい値に満たない間は pending です。
- ローカルモードのみ `GET /api/dev/aggregates` が
  `aggregateTotals`（numbers のみ）を返します。loopback 限定。

---

## 2. クライアント → ルーム エンベロープ

すべてのコマンドは 1 つのエンベロープに乗ります
（`packages/protocol/src/client-messages.ts`）:

```json
{
  "protocolVersion": 1,
  "commandId": "<uuid 等、64文字まで>",
  "gameId": "<roomId>",
  "expectedGameEpoch": 1,
  "type": "submitText",
  "payload": { "text": "..." }
}
```

| フィールド | 意味 |
| --- | --- |
| `protocolVersion` | サーバと一致必須。不一致は `error: unsupported-protocol` |
| `commandId` | 冪等キー（プレイヤー単位で dedupe） |
| `gameId` | ルーム id と一致必須。不一致は `error: wrong-room` |
| `expectedGameEpoch` | クライアントが最後に同期した世代。古いと `error: stale-epoch`（後述、`syncRequest` は免除） |
| `type`/`payload` | コマンド本体（下表） |

### コマンド一覧

| type | payload | 意味 |
| --- | --- | --- |
| `submitText` | `{ text }` | 投稿。game-core の `post` に写像（`playerId` はソケットから） |
| `pass` | `{}` | TURN モードの任意パス（現在のターンプレイヤーのみ） |
| `startGame` | `LobbySettings` | ホストのみ。ロビー設定つきでゲーム作成・開始 |
| `updateLobby` | `LobbySettings` | 開始前ロビー設定のパッチ |
| `requestDecision` | `{}` | ホストのみ。早期終了要求 → game-core `request-end` |
| `rematch` | `{}` | 終了後の再戦。`gameEpoch+1` の新ゲーム |
| `closeRoom` | `{}` | ホストのみ。`roomClosed` を配信して解体 |
| `heartbeat` | `{}` | プレゼンスリースの維持（dedupe 対象外） |
| `syncRequest` | `{ lastEventSeq? }` | ギャップ再同期。`snapshot` 応答が返る |

`LobbySettings`（すべて任意、範囲は game-core が再検証）:
`mode: "turn"|"live"`, `seed`, `turnSeconds`(1..300), `rounds`(1..12),
`liveSeconds`(1..1800), `maxPendingPerPlayer`(1..4),
`adhesionSeconds`(1..60), `settleSeconds`(1..30)。
`rosterSize`/`hostId`/プレイヤー列は宣言不可 — ルームがメンバー台帳から導出します。

---

## 3. ルーム → クライアント エンベロープ

すべてのサーバフレームは次の共通形です
（`packages/protocol/src/server-messages.ts`）:

```json
{
  "protocolVersion": 1,
  "eventSeq": 42,
  "stateRevision": 42,
  "gameId": "<roomId>",
  "gameEpoch": 1,
  "serverTime": 1727000000000,
  "type": "phaseChanged",
  "payload": { "event": { "type": "turn", "round": 2, "playerId": "..." }, "phase": "playing" }
}
```

| フィールド | 意味 |
| --- | --- |
| `eventSeq` | `events` テーブルに永続化された連番（= そのイベントの `state_revision`）。クライアントはこの連番のギャップを検知して再同期する |
| `stateRevision` | フレーム送出時点のルーム revision |
| `gameEpoch` | フレームが属するゲーム世代（rematch で +1） |
| `serverTime` | サーバ時刻（ms） |

### フレーム種別

| type | 順序対象 | payload | 意味 |
| --- | --- | --- | --- |
| `snapshot` | — | `{ state, phase, inputSeq, players, hostPlayerId }` | 完全同期点。接続直後と `syncRequest` 応答に送る。`eventSeq == stateRevision` |
| `ack` | — | `{ commandId, accepted: true, inputSeq, stateRevision }` | コマンド受理レシート。dedupe 済み再送は同じ ack をそのまま返す |
| `inputAccepted` | ✓ | `{ event, phase, post? }` | 投稿受理（`post` に本文を同梱） |
| `phaseChanged` | ✓ | `{ event, phase }` | フェーズ/ターン等の game-core イベント |
| `decisionUpdated` | ✓ | `{ postId?, revision?, distribution? }` | AI 評価結果が確定した投稿 |
| `hostChanged` | ✓ | `{ playerId }` | 実効ホストの交代 |
| `presenceChanged` | ✓ | `{ playerId, connected }` | 接続・切断 |
| `roomClosed` | ✓ | `{ reason }` | ルーム終了（以後ソケットは閉じられる） |
| `error` | — | `{ code, message, commandId? }` | 拒否はフレームで通知（クローズしない。ただし 16KiB 超フレームは通知後 1009 で切断） |

順序対象（`ORDERED`）は
`inputAccepted / phaseChanged / hostChanged / presenceChanged / decisionUpdated / roomClosed`
の 6 種です。`snapshot` は再同期点、`ack`/`error` は制御フレームで
順序ストリームには入りません。

`phaseChanged`/`inputAccepted` の `event` は game-core の `GameEvent`:
`started{roster}`, `turn{round,playerId}`, `passed{playerId}`,
`posted{postId,playerId}`, `complete{cutoffSeq,cause}`,
`end-requested{playerId}`, `finished{outcome}`。

---

## 4. 順序・ギャップ検知・スナップショット再同期

クライアント側の純粋な同期機械は `apps/web/src/net/sync.ts` にあります。

- `lastSeq` = 連続して適用済みの最大 `eventSeq`。
- `eventSeq <= lastSeq` のフレーム → `duplicate`（捨てる）。
- `eventSeq == lastSeq + 1` → `ordered`（適用。続くバッファ分も排出）。
- `eventSeq > lastSeq + 1` → `gap`: そのフレームをバッファし、
  呼び出し側は `syncRequest` を送る。
- `snapshot` 到着 → `stateRevision` まで `lastSeq` を進め、
  それより新しいバッファ分だけを連番どおりに再生する。
- `ack`/`error` は `control` として別系統で処理する。

サーバ側は `syncRequest` を dedupe せず、常に現行の `snapshot` フレームを
送り返します（`commands.ts`）。接続直後にも presence コミットの直後に
`snapshot` を 1 枚送るので、クライアントは「接続時スナップショット +
それ以降のイベント列」だけで正確に追いつけます。

`expectedGameEpoch` は古い世代への書き込みを防ぐ pin です。
不一致は `error: stale-epoch` で拒否されるので、クライアントは
`syncRequest` で世代を取り直します（`syncRequest` はこの検査を免除される）。

---

## 5. 冪等性・dedupe

- 受理コマンドは `commands` テーブルに
  `(playerId, commandId) -> {fingerprint, ack}` として記録されます。
- 同一 `commandId` で同一 fingerprint の再送 → **コミットせず保存済みの
  `ApplyResult` をそのまま ack 再生**します（WS 再送と RPC apply が
  二重コミットしないための機構）。
- 同一 `commandId` で異なる fingerprint →
  `RoomError idempotency-conflict` → `error` フレーム。
- `heartbeat` は dedupe 対象外（テーブルを小さく保つため）。
- `syncRequest` も dedupe しない（役割が「新しい snapshot を返す」こと）。

---

## 6. ticket / session / reconnect / 世代

- `sessionToken` → `POST /ticket` → 単回チケット → `GET /ws?ticket=`。
  チケットはハッシュで保持・消費時に比較。失効は `ticket-expired`/`bad-ticket`。
- ソケット切断時の再入は `POST /reconnect`（`reconnectToken`）で
  資格をローテーション → 新 `sessionToken` → 新チケット → 新ソケット。
- `socketGeneration` は接続ごとに +1。同一 playerId の旧ソケットは
  `1000 "replaced"` で閉じ、遅れて届いた旧世代の close イベントが
  新しい presence を消さないよう世代ガードを掛けます。
- クライアントの `RoomConnection` は指数バックオフでこの一連を
  自動化し、4xx/終端エラーで止まります。

---

## 7. presence / リース / ホスト選出 / ポーズ

- 接続中クライアントは `heartbeat` を固定周期で送り、
  `room_presence` のリース（`leaseMs`）を延ばします。
- リース切れは遅延スイープ（alarm + コマンド入口の lazy sweep）で
  `presenceChanged {connected:false}` として台帳化します。
- 全員切断（`emptySince`）すると `emptyGraceMs` の猶予が始まり、
  期限切れで `room-expired`（ルームは以後一切を拒否）。
  `playing` 中に全員切断した場合はマッチ系デッドラインが
  **ポーズ**され、再入時に経過分だけ時刻がシフトします（`pausedAtMs`）。
- 実効ホストは `room_presence.host_player_id` に永続化され、
  **接続中プレイヤーの最小 `joinOrder`**（同順は playerId 辞書順）に
  スティッキーに移ります。旧ホストが戻っても席は返りません。
  交代は `hostChanged` イベントとして永続化・配信され、
  ゲーム中なら `settings.hostId` も同一コミットで張り替えられます
  （`requestDecision` 権限が新ホストに移る）。

---

## 8. ゲームライフサイクルと終了規則

`phase`: `lobby -> playing -> complete -> finished`。

- `startGame`/`updateLobby`/`create` は作成+開始を 1 トランザクションで
  コミットし、`started` イベントを立てます。
- `playing` 中の投稿は `posted`（`inputAccepted`）→ 評価 `evaluate`
  コマンド → `ai_jobs` 行 → 上流呼出し → `evaluated` +
  `decisionUpdated` イベント。
- `complete` への移行で `settleCutoffSeq`（受理シーケンスの打ち止め）と
  `settleDeadlineAtMs`（= `settleSeconds` 猶予）が pin されます。
  打ち止めまでの投稿が全て評価済みなら新たな evaluate は発行されず、
  ルームは保持する分布から勝者クレームを導出して即座に `settle` します。
- `settle`（クレーム）: 打ち止め内に pending 投稿が残っていれば
  `noContest/pending` が強制されます（遅れて来た勝者評価で覆せない）。
  猶予切れのクレームは `too-late` で拒否。
- 猶予内にクレームが無ければ settle デッドラインが
  `noContest/timeout` を一度だけ確定します。
- `finished` は不変（以後の勝者クレームは効かない）。
- `rematch` は `gameEpoch+1` で新ゲームを開始し、クライアントは
  `expectedGameEpoch` の pin により新世代へ再同期します。

`GameOutcome`: `{kind:"winner",playerId,slot}` | `{kind:"draw"}` |
`{kind:"noContest",reason:"timeout"|"aborted"|"budget"|"pending"}`。

---

## 9. close / delete（ルーム終了と物理削除）

`closeRoom`（ホストのみ）は次の順序で解体します（`close.ts`）:

1. `roomClosed` イベントを台帳化・全ソケットへ配信
2. `room_registry` への登録を ControlPlane で revoke
3. `closed` フラグ + books 破棄（以後の read/command は `room-closed`）
4. 全ソケットを閉じ、`ctx.storage.deleteAll()` で物理削除
   （投稿・参加者・トークン・alarm・ai_jobs・outbox すべて）
5. `room_tombstone` 行（closed_at, wipe_state）で「閉じた」を耐久化

`deleteAll` が失敗しても tombstone `pending` が残るので、
再起動後の alarm が wipe をリトライして完了させます。
**tombstone のある roomId は再作成も変更もできません。**
全員切断による `room-expired` も同じ retire 経路に乗り、
purge までの hysteresis は `purgeDelayMs` で調整されます。

---

## 10. 集計（aggregate）契約

- ゲームが `finished` に遷移したとき、コミットトランザクション内で
  `outbox` 行 `{receiptId, payload}` を 1 行だけ挿入します
  （`aggregate-outbox.ts` の `onGameFinished`）。
- `payload` は numbers のみ:
  `{completedGames:1, totalMessages:seq, totalDurationMs}`。
- `noContest` 終了と評価用ルームは公開集計から除外します。
- フラッシュは `outbox-flush` デッドライン → `driveOutbox` →
  `ControlPlane.submitAggregate`。`receiptId` でサーバ側 dedupe されるため
  **同じゲームが 2 重に計上されることはありません**。
- 失敗時は指数バックオフ（上限つき）でリトライ、リトライ窓を
  超えたら破棄（一時的な集計損失は許容・ルームをブロックしない）。

---

## 11. トランスポートのガード（`transport.ts`）

| 条件 | 応答 |
| --- | --- |
| フレーム > 16KiB | `error: frame-too-large` → close `1009` |
| バイナリフレーム | `error: expected-text-frame` |
| JSON でない | `error: malformed-json` |
| エンベロープ形状不正 | `error: invalid-envelope` |
| `protocolVersion` 不一致 | `error: unsupported-protocol` |
| `gameId` 不一致 | `error: wrong-room` |
| `expectedGameEpoch` が古い | `error: stale-epoch`（`syncRequest` は免除） |
| レート超過（64 コマンド/10s/ソケット） | `error: rate-limited` |
| 添付（アタッチメント）なし | `error: unauthorized` → close `1008` |
| ルームが closed/expired | `error: room-closed`/`room-expired` |

エラーは原則としてフレーム通知のみでソケットは維持されます
（`frame-too-large` と `unauthorized` が例外的に切断）。
ゲームルール違反は `GameRuleError.reason`（`bad-state`/`too-late` など）が
そのまま `error.code` になり、`commandId` が分かれば同報されます。

主な `error.code` 一覧（HTTP 側も含む）:
`not-created`, `already-created`, `bad-invite`, `bad-session`,
`bad-reconnect`, `bad-ticket`, `ticket-expired`, `unknown-room`,
`room-full`, `room-closed`, `room-expired`, `platform-mismatch`,
`idempotency-conflict`, `unsupported-protocol`, `wrong-room`,
`stale-epoch`, `rate-limited`, `frame-too-large`, `expected-text-frame`,
`malformed-json`, `invalid-envelope`, `unauthorized`,
`forbidden-origin`, `invalid-request`, `too-large`, `config`, `internal`。

---

## 12. AI ジョブと中断回復（参考）

- 受理済み投稿は `ai_jobs` 行
  （`pending -> reserved -> sent -> done|failed`）を経て上流評価されます。
- 「sent」が正直な送信境界で、その後のクラッシュは消費済み試行として
  扱われます（at-most-once）。
- DO 再起動時、`reserved`/`sent` のまま残った行は中断試行として
  `failed` に抑制し、対応する ControlPlane 予約を `consume` します。
  `pending` のまま残った行は再起動後に再駆動されます。
- 上流 URL は `JEV_ENDPOINT`（本番）。ローカル/検証では
  `JEV_UPSTREAM_URL` バインディングで差し替えられます。
