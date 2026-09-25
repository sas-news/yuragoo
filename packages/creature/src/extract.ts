// Panel image cache (Task 30): eventId-keyed PNG Blobs captured from the
// live canvas via the renderer's extract path. These images never leave
// the client — they exist so the results view can show the pose a player
// actually watched without re-simulating it — so there is no upload path
// and nothing here touches the network. The cap mirrors the story
// contract's STORY_PANEL_MAX: a match can never need more cached frames
// than panels it can show.
import { STORY_PANEL_MAX } from "@yuragoo/protocol";
import type { Application } from "pixi.js";

export const MAX_PANEL_IMAGES = STORY_PANEL_MAX;

// Minimal structural source for a capture — CreatureRuntime satisfies
// this, and tests can stub it without a renderer.
export interface PanelImageSource {
  extractImage(): Promise<Blob | null>;
}

// One frame of the rendered stage as a PNG Blob: render the current
// frame, rasterize through extract.canvas, then encode. Returns null on
// context loss, a destroyed renderer, or canvases that can encode
// neither way (toBlob for HTMLCanvasElement, convertToBlob for
// OffscreenCanvas).
export async function extractFrameBlob(app: Application): Promise<Blob | null> {
  try {
    app.render();
    const captured = app.renderer.extract.canvas(app.stage);
    if (typeof captured.convertToBlob === "function") {
      return await captured.convertToBlob({ type: "image/png" });
    }
    if (typeof captured.toBlob === "function") {
      return await new Promise<Blob | null>((resolve) => {
        captured.toBlob?.((b) => resolve(b), "image/png");
      });
    }
    return null;
  } catch {
    // WebGL context loss mid-extract: caller falls back to the canonical
    // pose rather than holding a broken frame.
    return null;
  }
}

// Insertion-ordered cache: Map preserves insert order, so evicting the
// first key is FIFO. A hit refreshes recency — a panel the viewer flips
// back to keeps its frame instead of being evicted mid-browse.
const images = new Map<number, Blob>();

export async function capturePanelImage(
  runtime: PanelImageSource,
  eventId: number,
): Promise<Blob | null> {
  const cached = images.get(eventId);
  if (cached !== undefined) {
    images.delete(eventId);
    images.set(eventId, cached);
    return cached;
  }
  const blob = await runtime.extractImage();
  if (blob === null) return null;
  images.delete(eventId);
  images.set(eventId, blob);
  while (images.size > MAX_PANEL_IMAGES) {
    const oldest = images.keys().next().value;
    if (oldest === undefined) break;
    images.delete(oldest);
  }
  return blob;
}

export function panelImage(eventId: number): Blob | null {
  return images.get(eventId) ?? null;
}

// Drops one panel's frame (e.g. when its capture is superseded) — most
// teardown goes through releaseAll instead.
export function release(eventId: number): void {
  images.delete(eventId);
}

// Called when the results view unmounts: story images are per-match and
// must not leak into a rematch epoch.
export function releaseAll(): void {
  images.clear();
}

// Test/audit surface — the cap is the contract this exposes for checks.
export function size(): number {
  return images.size;
}
