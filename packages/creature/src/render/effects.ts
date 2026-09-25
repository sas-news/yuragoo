import { Container, Graphics } from "pixi.js";
import type { Vec2 } from "../attraction";
import { CREATURE_COLORS } from "./materials";

export type EffectKind = "anticipate" | "recoil" | "adhere";

const POOL_SIZE = 12;
const RING_SECONDS = 0.26;
const PARTICLE_LIFE: Readonly<Record<EffectKind, number>> = {
  anticipate: 0.16,
  recoil: 0.26,
  adhere: 0.5,
};
const PARTICLE_SPEED: Readonly<Record<EffectKind, number>> = {
  anticipate: 1.7,
  recoil: 2.6,
  adhere: 0.8,
};
const PARTICLE_COUNT: Readonly<Record<EffectKind, number>> = {
  anticipate: 4,
  recoil: 6,
  adhere: 4,
};

interface Particle {
  readonly view: Graphics;
  vx: number;
  vy: number;
  age: number;
  life: number;
  active: boolean;
  persistent: boolean;
}

export interface CreatureEffects {
  readonly root: Container;
  setOrigin(x: number, y: number): void;
  trigger(kind: EffectKind, direction: Vec2): void;
  update(dtSeconds: number, reducedMotion: boolean): void;
  activeParticles(): number;
  destroy(): void;
}

export function createCreatureEffects(): CreatureEffects {
  const root = new Container();
  const particles: Particle[] = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const view = new Graphics()
      .circle(0, 0, 0.05)
      .fill({ color: CREATURE_COLORS.bodyDeep, alpha: 0.9 });
    view.visible = false;
    root.addChild(view);
    particles.push({ view, vx: 0, vy: 0, age: 0, life: 0, active: false, persistent: false });
  }
  const ring = new Graphics()
    .circle(0, 0, 1)
    .stroke({ color: CREATURE_COLORS.bodyDeep, alpha: 0.6, width: 0.05 });
  ring.visible = false;
  root.addChild(ring);

  let originX = 0;
  let originY = 0;
  let dirX = 0;
  let dirY = 0;
  let adhering = false;
  let ringAge = Number.POSITIVE_INFINITY;

  const spawn = (kind: EffectKind, index: number, count: number): void => {
    const p = particles.find((candidate) => !candidate.active);
    if (!p) return;
    const spread = count <= 1 ? 0 : (index / (count - 1) - 0.5) * 1.2;
    const angle = Math.atan2(dirY, dirX) + spread;
    const speed = PARTICLE_SPEED[kind] * (0.85 + 0.15 * (index % 3));
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.age = 0;
    p.life = PARTICLE_LIFE[kind];
    p.persistent = kind === "adhere";
    p.active = true;
    p.view.alpha = 0.9;
    p.view.position.set(originX, originY);
    p.view.visible = true;
  };

  const hideAll = (): void => {
    for (const p of particles) {
      if (p.active) {
        p.active = false;
        p.view.visible = false;
      }
    }
    ring.visible = false;
    ringAge = Number.POSITIVE_INFINITY;
  };

  return {
    root,
    setOrigin: (x: number, y: number): void => {
      originX = x;
      originY = y;
    },
    trigger: (kind: EffectKind, direction: Vec2): void => {
      adhering = kind === "adhere";
      const length = Math.hypot(direction.x, direction.y);
      dirX = length > 1e-9 ? direction.x / length : 0;
      dirY = length > 1e-9 ? direction.y / length : 0;
      if (kind === "recoil") {
        ringAge = 0;
        ring.position.set(originX, originY);
        ring.scale.set(0.4);
        ring.alpha = 0.6;
        ring.visible = true;
      }
      const count = PARTICLE_COUNT[kind];
      for (let i = 0; i < count; i += 1) spawn(kind, i, count);
    },
    update: (dtSeconds: number, reducedMotion: boolean): void => {
      if (reducedMotion) {
        hideAll();
        return;
      }
      if (ringAge < RING_SECONDS) {
        ringAge += dtSeconds;
        const t = Math.min(1, ringAge / RING_SECONDS);
        ring.scale.set(0.4 + t * 1.1);
        ring.alpha = 0.6 * (1 - t);
        ring.visible = t < 1;
      } else {
        ring.visible = false;
      }
      for (const p of particles) {
        if (!p.active) continue;
        p.age += dtSeconds;
        if (p.age >= p.life) {
          if (p.persistent && adhering) {
            p.age = 0;
            p.view.position.set(originX, originY);
          } else {
            p.active = false;
            p.view.visible = false;
            continue;
          }
        }
        p.view.position.x += p.vx * dtSeconds;
        p.view.position.y += p.vy * dtSeconds;
        p.view.alpha = 0.9 * (1 - p.age / p.life);
      }
    },
    activeParticles: () => particles.reduce((n, p) => n + (p.active ? 1 : 0), 0),
    destroy: () => root.destroy({ children: true }),
  };
}
