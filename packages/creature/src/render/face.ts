import { Container, Graphics } from "pixi.js";
import type { CreatureExpression, FaceSummary } from "./lifecycle";
import { CREATURE_COLORS } from "./materials";

const EYE_X = 0.32;
const EYE_Y = -0.1;
const EYE_R = 0.17;
const PUPIL_R = 0.075;
const PUPIL_TRAVEL = 0.06;
const BLINK_PERIOD_SECONDS = 2.6;
const BLINK_SECONDS = 0.18;
const ALTERNATE_SECONDS = 1.1;
const ALTERNATE_BLEND = 0.85;

const EXPRESSION_OPEN: Readonly<Record<CreatureExpression, number>> = {
  rest: 1,
  hesitating: 0.9,
  engaged: 1,
  bored: 0.45,
  adhering: 1,
};

export interface FaceUpdateState {
  readonly gazeX: number;
  readonly gazeY: number;
  readonly altGazeX: number;
  readonly altGazeY: number;
  readonly expression: CreatureExpression;
  readonly reducedMotion: boolean;
  readonly elapsedSeconds: number;
}

export interface CreatureFace {
  readonly root: Container;
  update(state: FaceUpdateState): void;
  readSummary(): FaceSummary;
  destroy(): void;
}

interface Eye {
  readonly container: Container;
  readonly pupil: Graphics;
  readonly lid: Graphics;
}

const drawMouth = (mouth: Graphics, expression: CreatureExpression): void => {
  mouth.clear();
  const style = { color: CREATURE_COLORS.ink, width: 0.035, alpha: 0.85, cap: "round" as const };
  switch (expression) {
    case "bored":
      mouth.moveTo(-0.14, 0.32).lineTo(0.14, 0.32).stroke(style);
      break;
    case "hesitating":
      mouth.moveTo(-0.14, 0.32);
      for (let i = 1; i <= 4; i += 1) {
        mouth.lineTo(-0.14 + i * 0.07, i % 2 === 0 ? 0.32 : 0.28);
      }
      mouth.stroke(style);
      break;
    case "adhering":
      mouth.ellipse(0, 0.32, 0.06, 0.08).stroke(style);
      break;
    case "engaged":
      mouth.arc(0, 0.2, 0.16, Math.PI * 0.15, Math.PI * 0.85).stroke(style);
      break;
    default:
      mouth.arc(0, 0.24, 0.12, Math.PI * 0.2, Math.PI * 0.8).stroke(style);
  }
};

const createEye = (x: number): Eye => {
  const container = new Container();
  const white = new Graphics()
    .ellipse(0, 0, EYE_R, EYE_R * 1.15)
    .fill({ color: CREATURE_COLORS.highlight, alpha: 0.95 });
  const pupil = new Graphics().circle(0, 0, PUPIL_R).fill({ color: CREATURE_COLORS.ink });
  const lid = new Graphics()
    .ellipse(0, 0, EYE_R + 0.02, EYE_R * 1.2)
    .fill({ color: CREATURE_COLORS.body });
  // Anchor lid scaling at the upper eye edge so closure descends from the top.
  lid.pivot.y = -EYE_R * 1.2;
  lid.position.y = -EYE_R * 1.2;
  container.addChild(white, pupil, lid);
  container.position.set(x, EYE_Y);
  return { container, pupil, lid };
};

export function createCreatureFace(): CreatureFace {
  const root = new Container();
  const left = createEye(-EYE_X);
  const right = createEye(EYE_X);
  const mouth = new Graphics();
  root.addChild(left.container, right.container, mouth);
  let gazeX = 0;
  let gazeY = 0;
  let eyeOpen = 1;
  let lidTopY = -EYE_R * 1.2;
  let lidBottomY = lidTopY;
  let drawnExpression: CreatureExpression | null = null;

  const update = (state: FaceUpdateState): void => {
    let gx = state.gazeX;
    let gy = state.gazeY;
    if (
      state.expression === "hesitating" &&
      !state.reducedMotion &&
      Math.floor(state.elapsedSeconds / ALTERNATE_SECONDS) % 2 === 1
    ) {
      gx = gx * (1 - ALTERNATE_BLEND) + state.altGazeX * ALTERNATE_BLEND;
      gy = gy * (1 - ALTERNATE_BLEND) + state.altGazeY * ALTERNATE_BLEND;
    }
    const length = Math.hypot(gx, gy);
    if (length > 1) {
      gx /= length;
      gy /= length;
    }
    gazeX = gx;
    gazeY = gy;
    const blinking =
      !state.reducedMotion &&
      state.elapsedSeconds >= BLINK_PERIOD_SECONDS &&
      state.elapsedSeconds % BLINK_PERIOD_SECONDS < BLINK_SECONDS;
    eyeOpen = blinking ? 0.05 : EXPRESSION_OPEN[state.expression];
    const widen = state.expression === "adhering" ? 1.15 : 1;
    const lidScale = Math.max(0.001, 1 - eyeOpen);
    lidTopY = -EYE_R * 1.2;
    lidBottomY = lidTopY + 2 * EYE_R * 1.2 * lidScale;
    for (const eye of [left, right]) {
      eye.container.scale.x = widen;
      eye.pupil.position.set(gx * PUPIL_TRAVEL, gy * PUPIL_TRAVEL);
      eye.lid.scale.y = lidScale;
      eye.lid.visible = eyeOpen < 0.98;
    }
    if (drawnExpression !== state.expression) {
      drawnExpression = state.expression;
      drawMouth(mouth, state.expression);
    }
  };

  return {
    root,
    update,
    readSummary: () => ({
      x: root.position.x,
      y: root.position.y,
      gazeX,
      gazeY,
      eyeOpen,
      lidTopY,
      lidBottomY,
    }),
    destroy: () => root.destroy({ children: true }),
  };
}
