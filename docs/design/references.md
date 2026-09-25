# references.md — design decision provenance

Every consequential choice in `DESIGN.md` maps to the primary sources below.
S = `ゆらぐー！開発エージェント向け指示書.md` v0.1 (line numbers refer to that file).
Plan = `.omo/plans/yuragoo-development.md`.

## 1. Decision → source map

| Decision | Source |
| --- | --- |
| Game screen must not look like a generic web app; Canvas/Pixi-centered | S §5 (lines 215–248) |
| Translucent, soft, slime-like single-celled creature; two eyes + small mouth; smart but silly | S §6–7 (lines 252–300) |
| Judgement shown by body stretch/lean/gaze/tremble, never as numbers | S §8 (lines 303–338) |
| Deformation vocabulary: weak bulge / multi-lobe / tug-of-war / strong streamline / absorption with possible-reversal beat | S §9 (lines 342–387) |
| Real-time deformation (mesh + spring + inertia + volume preservation); feel over math | S §10 (lines 391–417) |
| Attractors on the perimeter, pulsing/links, radial layout by player count | S §11 (lines 421–448) |
| Design principles: pop, GUI-centric (no 3D), motion over stills, hide numbers, creature is always the protagonist | S §43 (lines 1371–1399) |
| Pop bright 2D stage; DOM for input/a11y/lobby/results, Canvas for creature/attraction/effects; no cards/probability bars/3D | Plan — Visual and story contract |
| Contour 64-point polar deformation, spring 1/120 s step, radius clamp, area ±15% | Plan — Visual and story contract; P1 |
| DPR≤2, 60/30 fps, hidden-tab pause, reduced-motion limits, WebGL-unsupported state | Plan — Visual and story contract; P2 |
| 5-panel ending, grapheme caps, non-numeric DOM state description | Plan — Visual and story contract |
| Pixi async init, dynamic vertex mesh, renderer/extract, ticker lifetime | P1/P2 — https://pixijs.com/8.x/guides/components/application , /components/scene-objects/mesh , /components/renderers , /concepts/performance-tips , /components/ticker |

## 2. Three-direction comparison

| Axis | A. SaaS dashboard / cards | B. Neon arcade / dark chrome | C. Warm paper theatre + jelly (adopted) |
| --- | --- | --- | --- |
| Creature silhouette | pushed aside by panels | readable but glare competes | sole protagonist, translucent body on paper |
| Background | card grid | dark neon glow | warm off-white paper + fiber noise |
| Label placement | inside cards | glowing chips | DOM around/under stage, symbol+slot anchored |
| Intent expression | numbers/bars (forbidden) | motion but harsh | body deformation only |
| Japanese text | small, gray-on-gray | glare hurts CJK strokes | ink on paper, ≥16 px |
| Reduced motion | N/A-heavy | flash/shake conflicts | ≤100 ms opacity transitions |
| Verdict | **rejected** — numerifies intent, displaces creature (S §5, §8, §43) | **rejected** — harms label readability, translucency, reduced-motion | **adopted** — matches S §5–§11, §43 |

## 3. Adopted direction rationale

Warm paper gives a calm, readable field where a translucent aqua/mint body is
legible at every deformation state, and where DOM ink text stays readable next to the
canvas. It satisfies "pop + GUI-centric + motion-first + numbers hidden + creature is
the protagonist" (S §43) without any dashboard vocabulary.

## 4. Font and license sources

- M PLUS Rounded 1c — official upstream: https://github.com/coz-m/MPLUS_FONTS ;
  specimen: https://fonts.google.com/specimen/M+PLUS+Rounded+1c ;
  license SIL OFL-1.1: https://openfontlicense.org/ (canonical text:
  https://scripts.sil.org/OFL).
- Fallback BIZ UDPGothic — https://fonts.google.com/specimen/BIZ+UDPGothic ;
  upstream: https://github.com/googlefonts/morisawa-biz-ud-gothic (OFL).
- **Obligation**: font binaries + OFL-1.1 license text must be vendored into the repo
  before production UI ships; no runtime Google Fonts request. Binaries are not yet
  vendored — tracked as a pre-production gate, not claimed done.

## 5. External image / lazyweb generation

Not used. Reference-only generated art is unnecessary for this contract (the visual
target is fully specified by tokens, topology and motion), and the plan forbids any
image-generation dependency in the product. This is explicitly **not a blocker** and
not an unmet precondition — it is a documented non-use.
