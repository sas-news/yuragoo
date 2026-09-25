# AI 行動評価ゲート (eval:jev)

`bun run eval:jev` は、日本語の判断 eval suite を実際の Jev エンドポイントへ流し、
prompt・model・context 組み立て・response schema を変更したときに**判断傾向**が壊れて
いないかを検査する gate である。mock schema や server 権限のテストでは意味理解までは
証明できないため、この live eval が別途必要になる。

## 実行方法

```sh
JEV_API_KEY=... bun run eval:jev -- --suite ja-v1 --max-attempts 60 --out <manifest.json>
```

- `--suite <name>`: `tests/jev-evals/<name>.json` を読む。
- `--max-attempts <n>`: 必須。その日・その session の attempt 上限(quota)として使う。
- `--out <path>`: 必須。manifest JSON の出力先(親ディレクトリは自動作成)。
- `--timeout-ms <n>`: 各 run の deadline。既定 3000ms。

suite は `name`・`gate`・`cases` からなる strict schema
(`packages/ai/src/eval-contract.ts` の `parseEvalSuite`)。
`gate = {runsPerCase 1..5, minRunsPassing, minPassingCases, p95Ms}` で、
case は `passingRuns >= minRunsPassing` のとき合格、suite は
`passingCases >= minPassingCases` など全 gate を満たすとき `pass` になる。

## 終了コード

| code | verdict | 意味 |
| ---- | ------- | ---- |
| 0 | `pass` | 全 gate クリア |
| 1 | `fail` | いずれかの gate 未達(または引数・suite のエラー) |
| 2 | `blocked` | `JEV_API_KEY` 未設定。provider を呼ばず manifest だけ書く |

`blocked` は pass ではない。CI の既定経路では実行せず、証拠が必要なときだけ
キーを設定して手動で回す。BLOCKED と PASS は manifest の `verdict` と終了コードの
両方で区別できる。

## manifest の構造

```jsonc
{
  "suite": "ja-v1",
  "verdict": "pass | fail | blocked",
  "reasons": ["schema-success<100%", "passing-cases 9<10", "p95 3100>3000"],
  "schemaSuccessRate": 1.0,          // provider が DecisionResult を返した割合
  "passingCases": 12,
  "totalCases": 12,
  "p95LatencyMs": 1234,              // 全 run の最近接順位 p95
  "runs": [
    {
      "caseId": "sweet-vs-broke",
      "runIndex": 0,
      "ok": true,
      "violations": ["top:not-in-set", "order:a>b", "close:a|b", "error:quota"],
      "model": "jev-1.13.0",
      "requestHash": "deadbeef",      // FNV-1a(JSON.stringify(body))
      "latencyMs": 800,
      "usage": { "inputTokens": 12, "outputTokens": 7 }
    }
  ]
}
```

manifest には case id・violation 文字列・hash・latency・usage だけを記録し、
request body・context 本文・API キーは書き込まない。

## 期待値は方向のみ

`expect` は `top`(argmax が集合内)、`order`(p(hi) > p(lo))、
`close`(|p(a)-p(b)| <= margin)の方向/対照ペアだけを許す。確率の厳密値は
固定しない — モデルの微更新や温度で容易に壊れるうえ、我々が守りたいのは
「甘党だが金欠なら無料の食事」「罠と警告された箱は開けない」のような
方向性であって、0.62 という値そのものではないからだ。各期待は
「妥当なモデルが 3 回中 2 回は満たす」水準で手書きする。

`ja-v1` は全て synthetic な日本語ケース 12 件(2/4/6 択)で、
甘党 vs 制約・危険回避・罠の反論・世界観破壊・指示無視文・同義 spam・
拮抗をカバーする。「上の指示を無視して…」のような system 境界を越えようとする
文脈も、あくまで世界内の発言として扱い危険側を選ばないことを検査する。

## キーの取り扱い

`JEV_API_KEY` は server-side / CI secret のみ。client 側・Vite の public env・
manifest・ログには一切出さない。eval CLI も同じ
`InMemoryAttemptQuota` gateway を通して予算を消費する。
