# プライバシーと削除

ゆらぐー！が保持するデータ、ルーム閉鎖時の削除手順、およびアプリ外
（Cloudflare バックアップ・AI プロバイダ）に残り得る範囲の整理。
Task 21（ルーム閉鎖・全文削除・匿名集計）時点の実装仕様。

## ルームが保持するデータ

GameRoom（Durable Object SQLite）にはルーム寿命中だけ次を保存する。

- 投稿本文・イベントログ（`events`）・ending の panel/pose
- 参加者 roster・表示用ホスト・presence/lease 情報
- 認証データ（招待 secret ハッシュ、session/reconnect トークンハッシュ、
  30秒 single-use ticket ハッシュ）— 平文はサーバーに残さない
- 実行中の AI job・着陸済み結果・世代スロット・集計 outbox 行
- ルームメタ（schema/epoch/revision/snapshot/settings）

招待 secret・session token は URL fragment / join body でのみ運ばれ、
サーバー保存はハッシュのみ。ログ・referrer・query に残さない。

## 閉鎖時の削除手順（アプリ即時論理削除）

明示的 `closeRoom`・empty 猶予切れの自動 purge・12時間寿命上限の
いずれでも同じ順序で閉じる。

1. ControlPlane の active-room mapping を revoke（registry は tombstone
   を残し、同一 roomId を二度と発行しない）。
2. ルーム epoch とメモリ上の authoritative state を無効化。
3. 全 socket を `1000 "room-closed"` で閉じる。
4. `ctx.storage.deleteAll()` で上記データを全削除。tombstone 行だけが
   削除簿記として残り、ユーザーデータを一切含まない。

削除に失敗した場合もルームは closed のまま拒否し、tombstone の pending
状態から alarm/再起動で wipe を再試行する。遅い AI・生成・集計 callback
は epoch と room 存在を検査して新しい row を作らない。再起動後に
tombstone が復元された room は永久に closed であり再初期化しない。

## 残り得るもの（約束しない領域）

- **Cloudflare PITR/バックアップ**: Durable Object ストレージは
  Cloudflare の point-in-time recovery の対象であり、公開仕様では
  30 日間の復元期間がある。`deleteAll()` はアプリ層の即時論理削除で
  あり、バックアップからの物理的即時消去は約束しない。稼働中ルームを
  PITR で復元する製品機能は提供しない（tombstone が残るため復元しても
  closed のままだが、それは削除機能ではなく安全弁）。
- **AI プロバイダ**: 評価のため投稿本文は AI gateway 経由で外部
  プロバイダへ送信される。プロバイダ側の保持・学習利用はそれぞれの
  プロバイダの条件に従い、本製品はその削除を保証しない。送信自体は
  `JEV_DAILY_ATTEMPTS`/`GENERATION_DAILY_ATTEMPTS` の明示設定がある
  場合に限られる。
- **集計 ControlPlane**: 受理済みの匿名数値（下記）と短命 receipt が
  残る。receipt は 24 時間 dedupe・最大 7 日で物理削除され、
  room/player/game への逆引き情報を一切持たない。

## 公開集計（匿名のみ）

`GET /api/stats` が返すのは全ルーム合算の数値だけ:

- `completedGames` / `totalMessages` / `totalDurationMs` / `averageDurationMs`

集計はゲーム完了時に GameRoom の outbox から numbers-only payload で
ControlPlane へ server-only 送信される。receiptId は room/player/game
と無関係な乱数。ルーム生存中のみ最大 5 分 retry し、閉鎖時に outbox は
破棄（集計待ちで削除を遅らせない、一時欠落は許容）。

公開は前の UTC 日までの日次バケットに限り、完了 20 試合未満は
`pending` を返す。noContest 試合と開発/評価ルームは公開集計に含めない。
表示名・ID・本文・自由選択肢名・個別勝者・ルーム別統計は公開しない。
アプリ内では「とうけい」リンクの小さなダイアログが同じ値を読むだけ。

## ops ログ（構造化・数値のみ）

サーバーの ops ログは `apps/server/src/observability.ts` の `logEvent`
が出す JSON 1行に限定される。出せるフィールドは `eventCode` /
`modelVersion` / `latencyBucket` / `errorKind` / `usage`（トークン数）
だけで、latency は `<1s`/`1-3s`/`3-10s`/`>10s` のバケットのみ。

リクエスト body、roomId、playerId、表示名、URL query、secret、
エラーの自由文はこの経路ではログに出さない。呼び出し側が渡すのは
固定コード（`timeout`・`http-503` など）だけなので、投稿本文や
個人が引っ付く経路は存在しない。
