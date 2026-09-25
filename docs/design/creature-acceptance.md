# Creature acceptance gate

## Scope

This gate closes Phase 1 only. It evaluates the production-like Pixi scene after Tasks 2–5; it does not approve game rules, AI behavior, multiplayer, or final release quality.

## Required states

| State | Required visual distinction |
| --- | --- |
| rest | centered body, neutral face, no directional particle cue |
| weak | small directional lobe and gaze without looking settled |
| split | two readable lobes and a hesitant face that alternates between tied slots |
| strong | one clearly longer/thicker lobe, fixed gaze, coherent centroid shift |
| reversal | dominant lobe, gaze, face and links move to the new slot without stale adhesion |
| final prototype | pre-attachment pose reaches `adhesionProgress=0.92` without declaring a winner |

The body must remain translucent with a single continuous silhouette, readable face, inner highlight, grounding shadow, and four complete attractors. A screenshot cannot prove motion; the pose JSON and recorded transition must agree with it.

## Responsive and accessible review

The 375, 768 and 1280 px captures must each cover normal, focus, loading, error and reduced-motion states. Controls remain at least 44 px, text at least 16 px, focus is visible, error uses text and an icon, and no probability value appears in player-facing scene UI. Reduced motion keeps direction, face and pose while suppressing particles, periodic blink and gaze alternation.

## Performance protocol

Measurements use the same Chromium installation and production-like E2E build:

- four-choice scene: 120 seconds after a 2-second warm-up; p95 requestAnimationFrame interval must be at most 20 ms;
- six-choice scene: 30 seconds; p95 at most 20 ms;
- Chromium CPU throttling rate 4 for 30 seconds; p95 at most 34 ms;
- ten mount/unmount resets end with zero active applications/tickers and equal created/destroyed counts;
- simulated hidden state lasts five seconds, permits at most one in-flight buffer update, resumes to a finite current pose, and never integrates the hidden duration as a giant frame.

These are local reference measurements, not device thermal or network SLAs. Raw intervals are summarized by count, mean, p95 and maximum; no samples are silently discarded.

## Evidence and decision

The run-specific decision is recorded in `task-6-visual-review.md`. Numerical results live in `task-6-happy.json`; responsive/state captures and pose summaries are linked from that review. Any failed numerical threshold, clipped state, resource leak, non-finite pose, or materially indistinguishable state blocks Wave 2 until corrected and rerun.
