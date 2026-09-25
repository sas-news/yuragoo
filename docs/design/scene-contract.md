# scene-contract.md — Pixi scene layer & primitive contract

Companion to `DESIGN.md`. Defines what the canvas draws, in what order, what the DOM
owns, and who resets what. Implements Task 2; verified visually in Task 6.

## 1. Layer order and ownership (bottom → top)

| # | Layer | Owner | Notes |
| --- | --- | --- | --- |
| 1 | paper background | Pixi scene | flat `#FFF7E8` + subtle fiber noise sprite; no UI text |
| 2 | grounding shadow | Pixi scene | `#72546A` @20% ellipse under body; scales with body lift |
| 3 | attractor links | Pixi scene | `body-deep` lines web→slot anchors; strength by attraction |
| 4 | body mesh | Pixi scene | 64-point polar contour fan mesh, `body` @72% alpha |
| 5 | inner highlight | Pixi scene | `inner-highlight` @70%, rides inside body volume |
| 6 | face | Pixi scene | **independent transform**: two eyes + small mouth; never deformed by body mesh |
| 7 | particles / effects | Pixi scene | pop, recoil, absorption; disabled under reduced motion |
| 8 | DOM label/focus overlay | DOM | status strip, candidate labels/list, input dock, result panel, focus ring, live region |

## 2. Body material and construction

- Contour: 64 vertices on a fixed angular order (polar radius deformation); order is
  never rearranged → self-intersection prevented.
- Material: translucent `body` fill at 72% alpha over paper; a single fan mesh —
  **no seams, no overlapping opaque parts**. Overlap must never produce darker bands.
- Inner highlight sits inside the silhouette, follows the same scale transform.
- Face is a separate display object with its own transform: it translates/rotates with
  the head direction but is **not** bound to contour vertices — it stays readable
  during extreme deformation (stretched lobes, split pull).
- Grounding shadow stays under the centroid; shrinks/fades as the body lifts toward
  an attractor.

## 3. Shape / position / label mapping

- Slot anchors are fixed by `choiceId` (DESIGN.md §4): A ○ top … F ⬡ upper-left.
- Attraction per `choiceId` → lobe radius/thickness toward that slot + centroid lean.
- The canvas anchor glyph is the choice symbol only; **all text labels live in DOM**
  (canvas never rasterizes choice text — no CJK clipping inside canvas).
- DOM label tray/list keeps symbol + slot + full label; association is by symbol and
  ordered position, never color.

## 4. Primitive ownership table

| Primitive | Renderer | Owns | Must not do |
| --- | --- | --- | --- |
| actor (creature) | Pixi | body mesh, face, shadow, pose from `PoseSnapshot` | compute win/loss, read network, draw text |
| attractor | Pixi anchor + DOM label | slot anchor, link, pulse | own label text in canvas, decide winner |
| text dock | DOM | input form, status strip, errors | overlap stage, hide behind canvas |
| result panel | DOM | captions, rematch/close | render before settlement, show numbers |

## 5. Reset and cleanup responsibilities

- Scene owns: ticker pause/resume, mesh/texture buffer reuse, particle pool drain,
  snapshot application on reconnect/resume (no huge-`dt` integration).
- React host owns: async `Application.init` mount/unmount safety (double-mount,
  abort mid-init), canvas detach, `destroy` of renderer, GPU resource release back
  to initial counts (verified in Task 6).
- DOM owns: label tray ordering, focus restore after phase transitions, result panel
  swap into the dock region.

## 6. Unsupported renderer state

WebGL unavailable → canvas is never mounted blank: the stage region shows a DOM
"unsupported environment" notice (`role="alert"`, ink on paper-raised), the ordered
DOM choice list remains fully readable, and the game cannot be started. No white
screen, no half-initialized ticker.

## 7. Layout breakpoints (summary; authoritative text in DESIGN.md §6)

| Width | Stage | Labels | Dock |
| --- | --- | --- | --- |
| ≥1024 | centered ≤1120×720 | anchored around ellipse | below stage |
| 768–1023 | full width, inset 24 | ≤14 rem, 2 lines | below stage |
| 375–767 (360 ok) | grid row, min 280 px (220 px w/ IME) | 6-choice: symbol-only + 2-col DOM tray | own row, last |
| <360 eff. / 200% zoom / IME | symbol-only anchors, stage ≥220 px under IME | 1-col bounded `overflow-y:auto` tray, full labels | sticky/pinned to visual viewport bottom above `env(safe-area-inset-bottom)` + software keyboard (`visualViewport` resize fallback where `100dvh` does not track IME), ≥44 px, never pushed outside the visual viewport |
