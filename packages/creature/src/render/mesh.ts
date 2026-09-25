import { Mesh, MeshGeometry, Texture } from "pixi.js";
import type { Vec2 } from "../attraction";
import { CONTOUR_POINT_COUNT } from "../contour";
import type { PoseSnapshot } from "../pose";
import { CREATURE_COLORS } from "./materials";

export const BODY_ALPHA = 0.72;
const UV_SPAN = 2.2 * 2;

export interface CreatureMesh {
  readonly view: Mesh;
  readonly geometry: MeshGeometry;
  update(snapshot: PoseSnapshot, scale: number, center?: Vec2): void;
  destroy(): void;
}

export function createCreatureMesh(initial: PoseSnapshot, scale: number): CreatureMesh {
  const positions = new Float32Array((CONTOUR_POINT_COUNT + 1) * 2);
  const uvs = new Float32Array((CONTOUR_POINT_COUNT + 1) * 2);
  const indices = new Uint32Array(CONTOUR_POINT_COUNT * 3);
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
    const point = initial.contour[i];
    uvs[(i + 1) * 2] = 0.5 + (point?.x ?? 0) / UV_SPAN;
    uvs[(i + 1) * 2 + 1] = 0.5 + (point?.y ?? 0) / UV_SPAN;
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = ((i + 1) % CONTOUR_POINT_COUNT) + 1;
  }
  const geometry = new MeshGeometry({ positions, uvs, indices });
  geometry.batchMode = "no-batch";
  const view = new Mesh({ geometry, texture: Texture.WHITE });
  view.tint = CREATURE_COLORS.body;
  view.alpha = BODY_ALPHA;

  const update = (snapshot: PoseSnapshot, nextScale: number, center?: Vec2): void => {
    const out = geometry.positions;
    const basis = center ?? snapshot.centroid;
    const cx = basis.x * nextScale;
    const cy = basis.y * nextScale;
    out[0] = cx;
    out[1] = cy;
    for (let i = 0; i < CONTOUR_POINT_COUNT; i++) {
      const point = snapshot.contour[i];
      out[(i + 1) * 2] = cx + (point?.x ?? 0) * nextScale;
      out[(i + 1) * 2 + 1] = cy + (point?.y ?? 0) * nextScale;
    }
    geometry.getBuffer("aPosition").update();
  };
  update(initial, scale);

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (view.parent) view.parent.removeChild(view);
    view.destroy({ texture: false, textureSource: false });
    geometry.destroy();
  };
  return { view, geometry, update, destroy };
}
