# DESIGN.md — ゆらぐー！ visual contract

Status: contract v1 (Task 2). This document fixes the visual direction, tokens, layout,
motion and state behavior. Final rendered-pixel approval belongs to Task 6.

## 1. Direction: warm paper theatre + translucent jelly

The stage is warm off-white paper with subtle fiber/noise texture only. The protagonist
is a **nameless translucent jelly creature**: aqua/mint body, inner highlight, soft
grounding shadow, two eyes and a small mouth, no limbs. It is intelligent but a little
silly; its body — stretch, lobes, lean, gaze, tremble, settle — is the only expression
of AI judgement.

Comparison of the three candidate directions and full rationale: `docs/design/references.md`.
Rejected here for the record:

- **SaaS/dashboard/cards/progress bars** — rejected: displaces the creature as the
  protagonist and numerifies intent, both forbidden by the source document.
- **Neon arcade/dark chrome** — rejected: glare harms Japanese label readability,
  translucency rendering, and reduced-motion accessibility.

## 2. Hard prohibitions (always apply)

- The creature has **no name** and UI never offers one.
- **No probability bars, percentages, or numeric odds** anywhere in normal UI.
- No 3D, no card/dashboard layout, no official proper nouns as game entities.
- No image-generation dependency; no runtime Google Fonts request.
- Color is decorative only; text uses ink/background pairs. Information is never
  carried by color alone (see §4).
- **No chamfered corners on thin-bordered elements.** A `clip-path` chamfer over a
  ~1.5–2px rim renders the diagonal hairline-thin (the player-name frame defect).
  Small elements keep sharp pointed corners; larger plates may keep a chamfer only
  with a rim of ≥3px (dock tray, lobby plate, dialog). No `border-radius` on
  rectangular UI — only true circles (avatar discs, slot dots) are round.

## 3. Visual tokens (fixed)

| Token | Value | Use |
| --- | --- | --- |
| paper | `#FFF7E8` | stage background |
| paper-raised | `#FFFDF6` | input dock, panels, result |
| ink | `#402F3B` | primary text, outlines |
| ink-muted | `#715E6B` | secondary text, captions |
| body | `#78DFC5` @ 72% alpha | creature body fill |
| body-deep | `#27A98B` | lobe cores, attractor links |
| inner-highlight | `#F4FFF9` @ 70% | creature inner highlight |
| grounding-shadow | `#72546A` @ 20% | contact shadow under body |
| focus | `#2458D3` | focus ring, active affordance |
| danger | `#B4233B` | errors (always paired with text/icon, never color alone) |
| loading | `#8A6D2F` | pending/pulse accent |

Spacing scale: `4 / 8 / 12 / 16 / 24 / 32 / 48` px.
Radii: `8 / 14 / 22 / pill`.
UI text: **≥16 px**. Action targets: **≥44×44 px**. Never shrink below either.

## 4. Choice identity — never color alone

Every choice keeps a stable `choiceId`, a fixed symbol, a fixed spatial slot, and its
full label. Editing a label during a game never changes identity or slot. Symbols and
slots persist across count changes; only positions adapt.

| choiceId | Symbol | Slot (6-choice canonical) |
| --- | --- | --- |
| A | ○ | top |
| B | ◇ | upper-right |
| C | △ | lower-right |
| D | □ | bottom |
| E | ☆ | lower-left |
| F | ⬡ | upper-left |

Per player count (positions move, IDs/symbols do not):

| Count | Arrangement |
| --- | --- |
| 2 | left / right |
| 3 | triangular |
| 4 | cardinal (top / right / bottom / left) |
| 5–6 | clockwise radial starting at top, retaining IDs/symbols |

Canvas anchors show the symbol glyph next to the attractor; the DOM label layer carries
the full text. Association is symbol + slot, not color.

## 5. Typography

- UI font: **M PLUS Rounded 1c** (SIL Open Font License 1.1), self-hosted/vendored
  before production UI. No runtime request to Google Fonts or any font CDN.
- Fallback stack: `"BIZ UDPGothic", "Yu Gothic", system-ui, sans-serif`.
- Minimum UI text 16 px; 40-grapheme labels wrap to at most 2 lines in normal layout;
  in overload layouts the full label stays reachable (see §6).
- Vendor obligation and upstream links: `docs/design/references.md` §4. Binaries are
  **not** vendored yet; this contract does not claim they are.

## 6. Layout contract

DOM shell regions (top→bottom): **status strip** → **Pixi stage** → **candidate-label
layer / accessible ordered choice list** → **input dock**. After settlement the
**result panel replaces the input dock region only**. Canvas draws creature,
attractors, effects only; DOM owns all meaningful text, forms, focus, errors and
accessibility.

| Breakpoint | Rules |
| --- | --- |
| ≥1024 px | centered stage, max 1120×720; input dock below; labels anchored around ellipse |
| 768–1023 px | stage fills available width; safe inset 24 px; label max-width 14 rem / 2 lines |
| 375–767 px (must work at 360) | stage and dock are separate grid rows; stage min-block 280 px (220 px with software keyboard); labels max 2 lines; at 6 choices stage anchors are symbol-only plus a two-column ordered DOM label tray between stage and input |
| 200% zoom or effective width <360 px | one-column ordered label tray; symbol-only stage anchors; input dock is sticky/pinned to the visual viewport bottom and always visible; tray gets bounded `overflow-y:auto`; stage never overlays input; full label always accessible via focus/title/description |
| IME keyboard open | shell height `100dvh`; dock stays pinned to the visual viewport bottom above `env(safe-area-inset-bottom)` and the software keyboard; label tray is bounded `overflow-y:auto`; the page must never use stage/tray growth to push the dock outside the visual viewport; where `100dvh` does not track the IME, drive dock position from `visualViewport` resize events; stage yields height before input is obscured |

Landscape (height < width on phones): stage is height-constrained first, dock keeps its
row, symbol/slot association retained; the stage never overlaps the input dock.

### 6.1 Diagram — 1280 px, 4 choices (cardinal)

```
┌──────────────────────── viewport 1280 ────────────────────────┐
│ status strip: room state · phase (aria-live, non-numeric)      │
│ ┌────────────────── stage max 1120×720 ──────────────────────┐ │
│              A ○ 「選択肢Aの全文ラベル」                       │
│                                                            │
│  D □ 「Dラベル」        ( (jelly) )        B ◇ 「Bラベル」     │
│                                                            │
│              C △ 「選択肢Cの全文ラベル」                       │
│ └────────────────────────────────────────────────────────────┘ │
│ input dock: [ 投稿テキスト (16px)            ] [送信 44×44]     │
└───────────────────────────────────────────────────────────────┘
```

### 6.2 Diagram — 768 px, 6 choices (clockwise radial)

```
┌────────────────────── viewport 768 ──────────────────────┐
│ status strip                                            │
│ ┌─────────────── stage full width, inset 24 ───────────┐ │
│            A ○ 「Aラベル」                              │
│     F ⬡ 「F…」                       B ◇ 「B…」          │
│                  ( (jelly) )                            │
│     E ☆ 「E…」                       C △ 「C…」          │
│            D □ 「Dラベル」                              │
│ └──────────────────────────────────────────────────────┘ │
│ input dock: [ 投稿テキスト ] [送信]                        │
└──────────────────────────────────────────────────────────┘
(labels: max-width 14rem, wrap ≤2 lines)
```

### 6.3 Diagram — 375 px, 6 choices (symbol anchors + 2-column tray)

```
┌────────────── viewport 375 ──────────────┐
│ status strip                             │
│ ┌──────── stage row (min 280px) ────────┐ │
│        A ○                               │
│   F ⬡        ( (jelly) )        B ◇      │
│        D □   E ☆      C △               │ │
│ └───────────────────────────────────────┘ │
│ label tray (DOM, 2 col, symbol+full text):│
│  ○ A 全文…       │ ◇ B 全文…             │
│  △ C 全文…       │ □ D 全文…             │
│  ☆ E 全文…       │ ⬡ F 全文…             │
│ input dock: [投稿]            [送信 44px]  │
└──────────────────────────────────────────┘
```

### 6.4 Diagram — 360 px / 200% zoom / IME keyboard (fallback)

```
┌────────── viewport 360 (or <360 effective) ──────────┐
│ status strip                                        │
│ ┌──── stage row (min 220px with IME open) ────────┐ │
│      symbol-only anchors around jelly              │
│ └─────────────────────────────────────────────────┘ │
│ label tray: ONE column, vertically scrollable       │
│  ○ A 「40字フルラベル…（全文、focus/title到達可）」 │
│  ◇ B 「…」  △ C 「…」  □ D 「…」                   │
│  ☆ E 「…」  ⬡ F 「…」                             │
│ input dock (sticky, pinned to visual viewport bottom│
│ above safe-area inset + IME keyboard):              │
│ [ 投稿テキスト 16px ]                    [送信 44×44]│
└─────────────────────────────────────────────────────┘
Rules: shell height is 100dvh; the dock is sticky/pinned to the visual
viewport bottom (visualViewport resize fallback where 100dvh does not
track the IME); the label tray is bounded overflow-y:auto; stage shrinks
(≥220px) before the dock is obscured; the page never pushes the dock
outside the visual viewport; no truncation of the only full label;
16px/44px minimums hold.
```

## 7. Motion tokens

| Token | Duration | Use |
| --- | --- | --- |
| anticipate | 80 ms | local pre-touch anticipation (reversible on server reject) |
| quick | 100 ms | reduced-motion state transition ceiling |
| respond | 160 ms | input acceptance / rejection feedback |
| settle | 260 ms | pose transitions, panel swaps |
| breathe | 1400 ms | idle body oscillation |
| wobble | 700 ms | post-impact jiggle |
| blink | 180 ms | eye blink |
| loading pulse | 900 ms | pending indicator on dock/status |

Only the creature and attractors express spontaneous life. UI chrome does not wiggle.

**Reduced motion**: disable oscillation, particles, flash, shake, parallax. Replace
state changes with ≤100 ms opacity/pose transitions. New leading direction, face and
gaze are still shown — no motion-only information anywhere.

**Hidden tab**: animation pauses; on resume the latest snapshot applies without
integrating a huge `dt`.

## 8. State matrix

Entry = what triggers the state; Exit = how it ends; Visual = non-numeric expression;
Copy = DOM text; A11y = focus/live-region behavior. `—` = not applicable for that
primitive. Focus is always visible (`focus` ring); error is never color-only;
aria-live announces only the latest meaningful event.

### 8.1 Actor (creature)

| State | Entry | Exit | Visual | Copy | A11y |
| --- | --- | --- | --- | --- | --- |
| normal/rest | round start, snapshot applied | any input accepted | breathing 1400 ms, occasional blink | — | DOM state text: "落ち着いている" |
| hover/focus | — (not interactive) | — | — | — | — |
| loading/pending | input accepted, awaiting eval | decision applied | subtle lean toward pending direction | — | — |
| error/rejected | server rejects input | next frame | quick 160 ms recoil, restore pose | — | — |
| disabled/readonly | settling/closed | results/aborted | freeze into current pose | — | — |
| weak | small lead | re-eval | slight bulge toward slot | — | DOM text notes direction |
| split/tied | two near-equal leads | re-eval | body stretched between lobes, trembling | — | DOM text: "拮抗している" |
| strong | clear lead | re-eval | streamlined body, fixed gaze, drifting toward slot | — | DOM text notes strong lean |
| reversal | lead changes side | re-eval | anticipate 80 ms + wobble 700 ms toward new lead | — | DOM text announces change |
| final/settled | cutoff evaluated | results shown | absorbed briefly onto winning attractor, then rest | — | DOM text: result heading |
| reconnecting | socket lost | resynced | freeze last pose; snapshot applied on resume | — | — |
| unsupported WebGL | renderer init fails | never (blocked) | — (canvas replaced) | unsupported notice | role="alert" |
| reduced-motion | media query on | off | pose jumps ≤100 ms, no wobble/particles | — | same DOM state text |

### 8.2 Attractor (per choice slot)

| State | Entry | Exit | Visual | Copy | A11y |
| --- | --- | --- | --- | --- | --- |
| normal/rest | game start | any change | gentle pulse on slot anchor | symbol + full label in DOM list | list item with symbol+label |
| hover/focus | pointer/keyboard on DOM item | blur | focus ring on DOM label; anchor brightens | — | visible focus, aria-describedby slot |
| loading/pending | eval running | applied | loading pulse 900 ms on links | — | — |
| error/rejected | — | — | — | — | — (errors live on dock) |
| disabled/readonly | not in game / settled | next game | dimmed anchor, label muted | — | aria-disabled on list item |
| weak | low attraction | re-eval | faint link line | — | — |
| split/tied | tied leads | re-eval | two equal-strength links | — | — |
| strong | dominant | re-eval | thicker body-deep link, stronger pulse | — | — |
| reversal | lead moves away | re-eval | link shrinks 160 ms | — | — |
| final/settled | winner fixed | results | winning anchor holds creature briefly | — | — |
| reconnecting | socket lost | resynced | anchors frozen | — | — |
| unsupported WebGL | init fails | — | DOM list remains fully usable | — | — |
| reduced-motion | media query on | off | static links, opacity changes only | — | — |

### 8.3 Text dock (input + status strip)

| State | Entry | Exit | Visual | Copy | A11y |
| --- | --- | --- | --- | --- | --- |
| normal/rest | lobby/playing | submit | paper-raised dock, 16 px input | placeholder「引っぱる言葉を書く」 | labelled textarea |
| hover/focus | focus into input | blur | focus ring | — | visible focus |
| loading/pending | submitted, awaiting ack | ack/timeout | loading pulse 900 ms, submit disabled | "送信中…" | aria-busy |
| error/rejected | schema/rate/timeout reject | edit/resubmit | danger icon + text, not color-only | concrete error string | role="alert", focus kept in dock |
| disabled/readonly | settling/closed/not playing | next phase | muted dock, controls disabled | "この枠は終了" / state text | aria-disabled |
| weak/split/strong/reversal | — | — | — | — | — (expressed by actor) |
| final/settled | results phase | rematch | dock replaced by result panel | — | focus moves to result heading |
| reconnecting | socket lost | resync | status strip warning | "再接続中…" | aria-live polite |
| unsupported WebGL | init fails | — | dock hidden; blocked screen | unsupported message + reload | role="alert" |
| reduced-motion | media query on | off | pulse → opacity fade | — | — |

### 8.4 Result panel (replaces input dock after settlement)

| State | Entry | Exit | Visual | Copy | A11y |
| --- | --- | --- | --- | --- | --- |
| normal/rest→final/settled | settle completes | rematch/close | paper-raised panel slides in 260 ms | winning choice label + panels captions | role="region", heading focus |
| loading/pending | generation pending | captions ready | loading pulse on caption slots | "紙芝居を準備中…" | aria-busy |
| error/rejected | generation fails | shown anyway | template fallback panels | fallback caption text | — |
| disabled/readonly | after room closed | — | static | — | — |
| weak/split/strong/reversal | — (panel shows recorded events) | — | — | event-based captions | — |
| reconnecting | socket lost mid-settle | resync | keep last snapshot | "再接続中…" strip | aria-live polite |
| unsupported WebGL | n/a (DOM-only panel) | — | panel still renders | — | — |
| reduced-motion | media query on | off | instant swap, no slide | — | — |
| hover/focus | rematch/close buttons | blur | focus ring, ≥44 px targets | — | keyboard-operable |

## 9. Accessibility invariants

- Focus ring (`focus` token) always visible; all actions keyboard reachable.
- Errors announced with icon + text; never color alone.
- A single aria-live region reports only the latest meaningful event (phase change,
  accepted/rejected input, result) — never per-frame pose data.
- The canvas is paired with a concise non-numeric DOM state description
  (e.g., "B の方向に強く伸びている") updated on meaningful change only.
- Reduced-motion path loses no information: direction/face/gaze/state remain.
