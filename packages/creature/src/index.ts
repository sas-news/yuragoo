import { CONTOUR_POINT_COUNT } from "./contour";
import { RENDERER_VERSION } from "./snapshot";

// Canonical pose-pipeline version — bump with any silhouette change so
// older captures/templates stay distinguishable (see snapshot.ts).
export const rendererVersion = RENDERER_VERSION;
export const contourPointCount = CONTOUR_POINT_COUNT;

export * from "./attraction";
export * from "./contour";
export * from "./extract";
export * from "./pose";
export * from "./replay-pose";
export * from "./render";
export * from "./snapshot";
export * from "./spring";
