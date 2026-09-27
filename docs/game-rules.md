# ゆらぐー！ game rules and tuning values

ローカル1画面パーティーゲーム（`/play`）および `packages/game-core` の
ルール定数の一覧。Phase-3 統合ゲート（Task 16）時点の baseline。
変更した値は「Owner changes」に理由つきで転記する。

## コアルール（packages/game-core）

### 設定値（settings.ts）

| knob | default | range | 意味 |
| --- | --- | --- | --- |
| `rosterSize` | — | 2..6 | 参加人数。`devMode` 時のみ 1 人 sandbox 可 |
| `turnSeconds` | 20 | 10/20/30/45/60 | TURN の1ターン制限時間（ルーム契約メニュー） |
| `rounds` | 3 | 1..8 | TURN の周回数（devMode のみ 12 まで） |
| `liveSeconds` | 120 | 60/120/180/300/600 | LIVE の試合時間（ルーム契約メニュー） |
| `maxPendingPerPlayer` | 1 | 1..4 | LIVE の未評価投稿数上限/人 |
| `adhesionSeconds` | 3 | 1..60 | dwell 早期終了に必要な吸着保持秒数 |
| `settleSeconds` | 8 | 1..30 | settle 猶予の上限（timeout backstop） |
| `hostId` | `playerIds[0]` | roster内 | request-end の権限者（room 作成者） |
| `seed` | — | safe int | 予約済み乱数枠（roster は joinOrder 固定） |

（devMode = ローカル /play の sandbox だけが自由値。本番ルームは上の
離散メニューのみ受理 — lobbySettingsSchema と GameSettings.tsx が一致）

### フェーズ遷移

- `create → start → playing → complete → finished`
- **TURN**: `turnOrder` 順に投稿。post受理で `turnIndex` 進行。`deadline-reached`
  はそのターンをパス。`round × rosterSize` 投稿で rounds 消化 → complete。
  `turnOrder` は roster（＝座席スロット順）を hostId 起点に回転したもの —
  つまり「ホストから時計回り」。ラウンドまたぎでも同じ順。
- **LIVE**: 全員いつでも投稿可（未評価は `maxPendingPerPlayer` まで）。
  `deadline-reached`（liveSeconds）で complete。
- **早期終了**:
  - `dwell-complete`: `adhesion` が `adhesionSeconds` 保持 かつ pending 0 で発火。
  - `request-end`: host のみ。どちらも通常の settle 窓に入る。
- **adhesion の解除**: 受理された投稿が来るたびに reducer の adhesion は
  クリアされる（遅れてきた逆転が必ず評価される保証）。
- **settle**: cutoff（`settleCutoffSeq`）内の最新 evaluated distribution の
  dominant slot が勝者。cutoff 内に pending 投稿が残ると noContest/pending。
  settle deadline 超過は noContest/timeout。

### 投稿テキスト（packages/protocol/text.ts）

- trim 後 1..140 grapheme（`Intl.Segmenter("ja")` 計測、UTF-16 length ではない）
- 上限超過・空は reduce/dock 双方で拒否

## ローカル調整値（apps/web/src/local）

| knob | value | 意味 |
| --- | --- | --- |
| `LOCAL_TURN_SECONDS` | 300 | ローカル TURN スロット（owner change、下記参照） |
| `DWELL_GRACE_DEFAULT` | 3 連続支配評価 | 早期終了の猶予（支配出現＋2投稿分） |
| `DWELL_GRACE_MAX` | 12 | `?grace=` 上限 |
| `DOMINANCE_MARGIN` | 0.15 | 支配判定の top-2 差（lab の CONFLICT_MARGIN と同値） |
| `SETTLE_GRACE_MS` | 2000 | complete 後、末尾評価の着地待ち |
| `WARN_REMAINING` | 20 | カウンター警告色の閾値（grapheme） |
| mock `favor-<id>` | 0.7 / 0.1 | 投稿者スロット支持の決定的 fixture |
| mock `contest` | 0.45 / 0.45 | 拮抗 fixture |
| シナリオ | おやつの時間。目の前に食べ物がならんでいる。 | 固定 |
| ペルソナ | 甘党の生きもの | 固定 |
| roster | aiko/ren/yuu/riku/sora/nagi | 固定6人、seed でシャッフル |
| 選択肢 | 6個、choice i ↔ slot i | スロット記号と対応 |

### URL ノブ（`parseLocalParams`、e2e/検証用）

`players`(2..6) `mode`(turn|live) `seed` `eval`(mock|live) `evalDelay`(0..30000ms)
`failEval` `turn` `live` `dwell` `settle` `rounds` `grace`

## 演出・提示の調整値

| knob | value | 意味 |
| --- | --- | --- |
| 吹き出し保持 | 約 4.5 秒 | ポップイン(約380ms)→静止表示→消去。移動なし |
| 「聞いた」フリッカー | 約 950 ms | hesitating リング。投稿到達の承認済み演出 |
| 吹き出しテキスト | 20px / 最大3行 / 80 grapheme | 角ばった SVG 枠＋スロット色の尾 |
| 座席ジオメトリ | OUTWARD 48px / EDGE 10px / chip 200×68 | アトラクター外側に chip を植える。chip 実測 ~197×52 +余裕 |
| 狭幅座席マージン | <640px で上端 92px | HUD/strip との重なり防止（NARROW_TOP_PX） |
| シナリオstrip幅 | min(460px, 32%) / ≤640px は 60% | 上座ゾーンに届かない上限 |
| スロット色 | #2fa98b #e0709a #f0a03c #5f7fdb #8f6fd8 #58b364 | slot 0..5 |
| スロット記号 | ○ ◇ △ □ ☆ ⬡（A–F 表記併用） | choice i ↔ slot i |
| HUD | 非数値（確率表示なし、deadline はバー） | 身体表現主義 |

## Owner changes（初期値からの変更・理由つき）

1. **TURN スロット 30s → 300s（ローカル）** — 1画面パーティーでは壁時計で
   急がせない。deadline が試合を乗っ取らないよう LOCAL_TURN_SECONDS=300。
   コア default 30s はオンライン向けに据え置き。
2. **早期終了を秒数 dwell → 連続支配 streak（投稿数）に変更（Task 15b）** —
   「吸着リング＝即終了に見える」フィードバックより、同スロット支配評価が
   `grace` 回連続した時だけ発火。支配出現後に猶予2投稿を保証し、拮抗評価は
   streak をリセットするため迷い中は勝手に終わらない。
3. **adhering 表情・吸着リングの撤去** — 演出不要の指摘により
   `expression` は常に `"rest"`。adhere は reducer bookkeeping として内部維持。
4. **adhere の毎回再報告** — 受理投稿で reducer の adhesion が消えるため、
   支配が続く限り dominant step ごとに再発行する（再発行しない旧実装は
   「リングが一瞬しか出ない」バグの原因だった）。
5. **狭幅 roster 縮退・撤去** — 1040px 未満で roster chip は名前を隠して
   スロット記号のみ、640px 未満では roster 自体を非表示（座席 chip が
   名前・色・ねらい・パルスを持つため情報は重複）。折り返しによる上座・
   strip との重なりを防ぐ。
6. **狭幅 dock 2行化** — 640px 未満で who 列を全幅1行（席+ねらい横並び）
   にして入力と送信を2行目に並べる（375px で入力が幅0に潰れる実害の修正）。
7. **座席クランプを実測サイズに** — chip 想定 140×64 → 実測 ~197×52 に
   合わせ 200×68 へ（画面端はみ出し修正）。≤640px は chip 自体を縮小。
