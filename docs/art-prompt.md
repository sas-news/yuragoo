# アート生成プロンプト（本番用アイコン/OGP の依頼文）

現在配信中の `apps/web/public/icon.svg`・`og.png` はプレースホルダー。
本番品質の画像を外部の画像生成やイラストレーターに依頼するための指示書。
制作後は `icon-512.png` / `apple-touch-icon.png` / `og.png` を差し替えるだけでよい。

## キャラクター仕様（ゲーム内レンダリングと同一にすること）

- 名前のない生命体。**名前・台詞・擬人化した服や手足は付けない**
- 形：丸い柔らかいブロブ（不定形に近いが、基本はほぼ球体〜少し潰れた餅状）
- 体色：ミントグリーン `#78dfc5`、下部に深みのあるティール `#27a98b` の陰影
- 目：縦長の楕円が2つ（白目 `#f4fff9`＋濃いインク色の丸い瞳 `#402f3b`）、顔の中央よりやや上に離れて配置
- 口：小さく穏やかな弧（微笑み程度）。歯・舌なし
- 背景色が必要な場合：クリーム `#fff7e8`
- 雰囲気：手作り感・紙芝居調・柔らかい。コワくしない・リアルにしすぎない・グロテスク不可
- 輪郭線：あってもごく薄いティール。強い黒線はゲームの質感と違うので避ける

## 必要な成果物

| 用途 | サイズ | 出力先 |
|---|---|---|
| アプリアイコン（Discord Developer Portal・PWA） | 512×512 以上 PNG | `apps/web/public/icon-512.png` |
| Apple touch icon | 180×180 PNG（背景クリーム、透過不可） | `apps/web/public/apple-touch-icon.png` |
| OGP / SNS シェア画像 | 1200×630 PNG | `apps/web/public/og.png` |

## 画像生成プロンプト（英語・そのまま使える）

```
A soft round mint-green blob creature with no limbs, no name, and no clothing,
resting on a plain warm cream background (#fff7e8). The creature's body is a
squishy jelly-like sphere colored mint (#78dfc5) with a deeper teal (#27a98b)
shading along its lower curve. It has two vertical oval eyes with white sclera
(#f4fff9) and round dark-plum pupils (#402f3b), set slightly above center and
spaced apart, giving a gentle curious look. A tiny, calm curved-line smile sits
below the eyes. Style: warm storybook / kamishibai illustration, soft matte
texture, subtle paper grain, tender and friendly, minimal detail, no outlines
heavier than a faint teal rim. No text, no props, no scenery.
Square composition, creature centered, single subject.
```

### OGP 版（横長・文字スペースを残す場合）

同プロンプトの末尾を差し替え：

```
Wide 1200x630 banner composition: the creature sits on the right third,
leaving the left two-thirds empty warm cream for title text overlay.
Three soft, curved arrow strokes in pink (#e0709a), orange (#f0a03c) and
blue (#5f7fdb) arc gently from the left edge toward the creature, as if
unseen players' words are tugging it. Everything else identical to the
icon description.
```

## NG チェックリスト（採用前確認）

- [ ] 手足・角・口内・鼻・眉が付いていない
- [ ] 文字が入っていない（ロゴ化は別工程）
- [ ] 色味が `#78dfc5` 系ミントから逸脱していない
- [ ] 瞳が丸く白目あり（ゲーム内と同じ顔の構成）
- [ ] 怖くない・疲れて見えない
