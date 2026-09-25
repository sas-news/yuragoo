import { Hono } from "hono";
import { createAuthApp } from "./auth/browser";
import type { ServerBindings } from "./config";
import { parseServerMode } from "./config";
import { createApp } from "./dev-gateway";

// Named exports so the wrangler durable_objects bindings find the classes.
export { GameRoom } from "./rooms/GameRoom";
export { ControlPlane } from "./control/ControlPlane";

// One cached app per mode so the local dev gateway keeps its shared quota
// across requests inside this isolate. The room-auth API mounts identically
// in both modes; local mode only adds the dev JEV gateway on top.
let cached: { mode: "local" | "production"; app: Hono } | null = null;

export default {
  fetch(
    request: Request,
    env: ServerBindings,
    ctx: ExecutionContext,
  ): Promise<Response> | Response {
    const mode = parseServerMode(env?.APP_ENV);
    if (cached === null || cached.mode !== mode) {
      const app = new Hono();
      app.route("/", createAuthApp(env ?? {}));
      app.route("/", createApp(env ?? {}));
      cached = { mode, app };
    }
    return cached.app.fetch(request, env, ctx);
  },
};
