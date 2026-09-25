import { Container, Graphics } from "pixi.js";
import type { AttractionSample } from "../attraction";
import { CREATURE_COLORS } from "./materials";

const MAX_SLOTS = 6;
const ATTRACTOR_RADIUS = 2.2;
const OUTER_RATIO = 0.28;
const EDGE_INSET = 8;

export const CANONICAL_SLOT_ANGLES: Readonly<Record<number, readonly number[]>> = {
  2: [Math.PI, 0],
  3: [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6],
  4: [-Math.PI / 2, 0, Math.PI / 2, Math.PI],
  5: [-Math.PI / 2, -Math.PI / 10, (Math.PI * 3) / 10, (Math.PI * 7) / 10, (Math.PI * 11) / 10],
  6: [-Math.PI / 2, -Math.PI / 6, Math.PI / 6, Math.PI / 2, (Math.PI * 5) / 6, (Math.PI * 7) / 6],
};

export interface AttractorLayer {
  readonly root: Container;
  readonly orbit: number;
  layout(width: number, height: number, scale: number): void;
  update(normalized: readonly AttractionSample[], actorX: number, actorY: number): void;
  setEmphasis(emphasized: boolean): void;
  activeAttractors(): readonly Graphics[];
  destroy(): void;
}

export function createAttractorLayer(): AttractorLayer {
  const root = new Container();
  const links: Graphics[] = [];
  const attractors: Graphics[] = [];
  for (let i = 0; i < MAX_SLOTS; i += 1) {
    const link = new Graphics()
      .rect(0, -0.5, 1, 1)
      .fill({ color: CREATURE_COLORS.bodyDeep, alpha: 1 });
    link.visible = false;
    links.push(link);
    const attractor = new Graphics()
      .circle(0, 0, 0.26)
      .stroke({ color: CREATURE_COLORS.bodyDeep, alpha: 0.5, width: 0.04 })
      .circle(0, 0, 0.16)
      .fill({ color: CREATURE_COLORS.bodyDeep, alpha: 0.8 });
    attractor.visible = false;
    attractors.push(attractor);
  }
  root.addChild(...links, ...attractors);

  let orbit = 0;
  let scale = 1;
  let emphasized = false;
  let actorX = 0;
  let actorY = 0;
  let activeCount = 4;
  let slotAngles: readonly number[] = CANONICAL_SLOT_ANGLES[4] ?? [];
  let normalized: readonly AttractionSample[] = [];

  const place = (): void => {
    for (let i = 0; i < MAX_SLOTS; i += 1) {
      const attractor = attractors[i];
      const link = links[i];
      if (!attractor || !link) continue;
      const weight = normalized[i]?.weight ?? 0;
      const active = i < activeCount;
      attractor.visible = active;
      link.visible = active && weight > 0.01;
      if (!active) continue;
      const angle = slotAngles[i] ?? 0;
      const ax = orbit * Math.cos(angle);
      const ay = orbit * Math.sin(angle);
      attractor.position.set(ax, ay);
      attractor.alpha = Math.min(1, 0.45 + 1.8 * weight) * (emphasized ? 1 : 0.85);
      const dx = ax - actorX;
      const dy = ay - actorY;
      const length = Math.max(0, Math.hypot(dx, dy) - OUTER_RATIO * scale);
      link.position.set(actorX, actorY);
      link.rotation = Math.atan2(dy, dx);
      link.scale.set(length, Math.max(1, scale * (0.015 + 0.05 * weight)));
      link.alpha = Math.min(0.6, 0.12 + 0.5 * weight);
    }
  };

  return {
    root,
    get orbit() {
      return orbit;
    },
    layout: (width: number, height: number, nextScale: number): void => {
      scale = nextScale;
      orbit = Math.max(
        0,
        Math.min(
          ATTRACTOR_RADIUS * scale,
          width / 2 - OUTER_RATIO * scale - EDGE_INSET,
          height / 2 - OUTER_RATIO * scale - EDGE_INSET,
        ),
      );
      for (const attractor of attractors) attractor.scale.set(scale);
      place();
    },
    update: (next: readonly AttractionSample[], nextActorX: number, nextActorY: number): void => {
      normalized = next;
      activeCount = Math.min(MAX_SLOTS, next.length);
      slotAngles = CANONICAL_SLOT_ANGLES[activeCount] ?? [];
      actorX = nextActorX;
      actorY = nextActorY;
      place();
    },
    setEmphasis: (next: boolean): void => {
      emphasized = next;
      place();
    },
    activeAttractors: () => attractors.slice(0, activeCount),
    destroy: () => root.destroy({ children: true }),
  };
}
