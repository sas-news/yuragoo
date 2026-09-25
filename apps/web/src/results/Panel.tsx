// One kamishibai page (Task 32): the creature silhouette is redrawn from
// the panel's canonical pull (raw per-slot probabilities -> the same
// replaySamples shaping the arena uses -> deterministic PoseSnapshot), so
// every member sees the identical moment without any bitmap upload.
import { useMemo } from "react";
import { CANONICAL_SLOT_ANGLES, canonicalPose } from "@yuragoo/creature";
import type { StoryPanel as WirePanel } from "@yuragoo/protocol";
import styles from "./Results.module.css";

// The blob as an SVG path — polar contour -> XY, scaled to the viewBox.
// Contour radii are normalized to the creature's rest radius, so a fixed
// scale keeps every silhouette inside frame even at the pull extremes.
const BLOB_SCALE = 62; // px per rest-radius unit inside a 160x160 viewBox
const CENTER = 80;

const blobPath = (pose: ReturnType<typeof canonicalPose>): string => {
  const pts = pose.contour;
  if (pts.length === 0) return "";
  const first = pts[0];
  if (first === undefined) return "";
  const parts: string[] = [
    `M ${(CENTER + first.x * BLOB_SCALE).toFixed(1)} ${(CENTER + first.y * BLOB_SCALE).toFixed(1)}`,
  ];
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (p === undefined) continue;
    parts.push(
      `L ${(CENTER + p.x * BLOB_SCALE).toFixed(1)} ${(CENTER + p.y * BLOB_SCALE).toFixed(1)}`,
    );
  }
  parts.push("Z");
  return parts.join(" ");
};

// The two eyes ride the centroid + dominant gaze — a small face cue, not
// the full Pixi face rig (panels are stills, not the live actor).
const faceParts = (
  pose: ReturnType<typeof canonicalPose>,
): { x: number; y: number; g: number } => ({
  x: CENTER + pose.centroid.x * BLOB_SCALE,
  y: CENTER + pose.centroid.y * BLOB_SCALE,
  g: pose.dominantAngleRad ?? Number.NaN,
});

// Attractor markers: one small tick per slot on its canonical angle, the
// winning direction emphasized by the silhouette itself — no numerals.
const attractorTicks = (pull: readonly number[] | null): { a: number; w: number }[] =>
  pull === null
    ? []
    : (CANONICAL_SLOT_ANGLES[pull.length] ?? []).map((a, i) => ({ a, w: pull[i] ?? 0 }));

export interface PanelProps {
  readonly panel: WirePanel;
}

export function Panel({ panel }: PanelProps) {
  const pose = useMemo(() => canonicalPose(panel.pull), [panel.pull]);
  const ticks = useMemo(() => attractorTicks(panel.pull), [panel.pull]);
  const face = faceParts(pose);
  const gazeDx = Number.isFinite(face.g) ? Math.cos(face.g) * 3.5 : 0;
  const gazeDy = Number.isFinite(face.g) ? Math.sin(face.g) * 3.5 : 0;
  return (
    <figure className={styles.panel} data-testid="kamishibai-panel" data-kind={panel.kind}>
      <svg className={styles.art} viewBox="0 0 160 160" role="img" aria-label="いきもののすがた">
        {ticks.map((t) => (
          <circle
            key={t.a}
            cx={CENTER + Math.cos(t.a) * 66}
            cy={CENTER + Math.sin(t.a) * 66}
            r={2 + t.w * 4}
            className={styles.tick}
          />
        ))}
        <path className={styles.blob} d={blobPath(pose)} />
        <circle className={styles.eye} cx={face.x - 8 + gazeDx} cy={face.y - 4 + gazeDy} r={2.6} />
        <circle className={styles.eye} cx={face.x + 8 + gazeDx} cy={face.y - 4 + gazeDy} r={2.6} />
        <ellipse
          className={styles.mouth}
          cx={face.x + gazeDx}
          cy={face.y + 6 + gazeDy}
          rx={3.4}
          ry={1.8}
        />
      </svg>
      <figcaption>
        <h3 className={styles.panelTitle} data-testid="panel-title">
          {panel.title}
        </h3>
        <p className={styles.panelCaption} data-testid="panel-caption">
          {panel.caption}
        </p>
        {panel.quotes.length > 0 && (
          <ul className={styles.quotes} aria-label="この場面のことば">
            {panel.quotes.map((q) => (
              <li key={q.postId} className={styles.quote} data-testid="panel-quote">
                「{q.text}」
              </li>
            ))}
          </ul>
        )}
      </figcaption>
    </figure>
  );
}
