// One kamishibai page (Task 32): the creature silhouette is redrawn from
// the panel canonical pull (raw per-slot probabilities -> the same
// replaySamples shaping the arena uses -> deterministic PoseSnapshot), so
// every member sees the identical moment without any bitmap upload.
import { useMemo } from "react";
import { CANONICAL_SLOT_ANGLES, canonicalPose } from "@yuragoo/creature";
import type { StoryPanel as WirePanel } from "@yuragoo/protocol";
import styles from "./Results.module.css";

// The panel still mirrors the live rig in packages/creature/src/render:
// contour + shadow + highlight + face geometry all keep the rig units
// (1.0 = rest radius) under one scale. The whole scene is lifted off the
// card center so the ground shadow stays inside the viewBox.
const SCALE = 62; // px per rest-radius unit
const SCENE_X = 80;
const SCENE_Y = 74;
const FACE_OFFSET = 0.16 * SCALE;
const PUPIL_TRAVEL = 0.06 * SCALE;
const EYE_X = 0.32 * SCALE;
const EYE_Y = -0.1 * SCALE;
const EYE_RX = 0.17 * SCALE;
const EYE_RY = 0.195 * SCALE;
const PUPIL_R = 0.075 * SCALE;
const TICK_ORBIT = 66;

// The blob as an SVG path — mesh.update writes (centroid + contour) *
// scale, so the silhouette leans toward the pull like the arena actor.
const blobPath = (pose: ReturnType<typeof canonicalPose>): string => {
  const pts = pose.contour;
  if (pts.length === 0) return "";
  const first = pts[0];
  if (first === undefined) return "";
  const cx = pose.centroid.x * SCALE;
  const cy = pose.centroid.y * SCALE;
  const parts: string[] = [
    `M ${(cx + first.x * SCALE).toFixed(1)} ${(cy + first.y * SCALE).toFixed(1)}`,
  ];
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (p === undefined) continue;
    parts.push(`L ${(cx + p.x * SCALE).toFixed(1)} ${(cy + p.y * SCALE).toFixed(1)}`);
  }
  parts.push("Z");
  return parts.join(" ");
};

// Attractor markers: one small tick per slot on its canonical angle, the
// same fixed orbit the arena layer centers on the scene origin.
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
  const centerX = pose.centroid.x * SCALE;
  const centerY = pose.centroid.y * SCALE;
  const faceX = centerX + pose.gaze.x * FACE_OFFSET;
  const faceY = centerY + pose.gaze.y * FACE_OFFSET;
  const pupilX = pose.gaze.x * PUPIL_TRAVEL;
  const pupilY = pose.gaze.y * PUPIL_TRAVEL;
  // The rig rest mouth: arc(0, 0.24, r=0.12, 0.2PI -> 0.8PI) as an ink
  // round-capped stroke; arc endpoints are precomputed in px.
  const mouthPath = `M ${(faceX + 6.1).toFixed(1)} ${(faceY + 19.3).toFixed(1)} A 7.4 7.4 0 0 1 ${(faceX - 6.1).toFixed(1)} ${(faceY + 19.3).toFixed(1)}`;
  return (
    <figure className={styles.panel} data-testid="kamishibai-panel" data-kind={panel.kind}>
      <svg className={styles.art} viewBox="0 0 160 160" role="img" aria-label="いきもののすがた">
        <g transform={`translate(${SCENE_X} ${SCENE_Y})`}>
          {ticks.map((t) => (
            <circle
              key={t.a}
              cx={Math.cos(t.a) * TICK_ORBIT}
              cy={Math.sin(t.a) * TICK_ORBIT}
              r={2 + t.w * 4}
              className={styles.tick}
            />
          ))}
          <ellipse
            className={styles.shadow}
            cx={0}
            cy={1.18 * SCALE}
            rx={0.95 * SCALE}
            ry={0.22 * SCALE}
          />
          <path className={styles.blob} d={blobPath(pose)} />
          <ellipse
            className={styles.highlight}
            cx={centerX - 0.3 * SCALE}
            cy={centerY - 0.36 * SCALE}
            rx={0.42 * SCALE}
            ry={0.26 * SCALE}
          />
          {[-1, 1].map((side) => (
            <g key={side}>
              <ellipse
                className={styles.eyeWhite}
                cx={faceX + side * EYE_X}
                cy={faceY + EYE_Y}
                rx={EYE_RX}
                ry={EYE_RY}
              />
              <circle
                className={styles.pupil}
                cx={faceX + side * EYE_X + pupilX}
                cy={faceY + EYE_Y + pupilY}
                r={PUPIL_R}
              />
            </g>
          ))}
          <path className={styles.mouth} d={mouthPath} />
        </g>
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
