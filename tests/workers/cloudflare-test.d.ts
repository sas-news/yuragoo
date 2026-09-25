// Minimal ambient types for the vitest-pool-workers `cloudflare:test` module.
// The pool's own types live behind a subpath our tsconfig does not include;
// only the pieces the worker tests exercise are declared here. Global
// workers-types (DurableObjectNamespace, DurableObjectStub, ...) come from
// tsconfig.node.json's `types` array.
declare module "cloudflare:test" {
  type Room = import("../../apps/server/src/rooms/GameRoom").GameRoom;
  type Control = import("../../apps/server/src/control/ControlPlane").ControlPlane;

  export const SELF: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  };

  // Bindings declared in apps/server/wrangler.jsonc plus the test-only
  // vars injected by vitest.workers.config.ts miniflare.bindings.
  export const env: {
    readonly GAME_ROOM: DurableObjectNamespace<Room>;
    readonly CONTROL_PLANE: DurableObjectNamespace<Control>;
    readonly ALLOWED_ORIGINS?: string;
    readonly ROOM_HEARTBEAT_MS?: string;
    readonly ROOM_LEASE_MS?: string;
    readonly ROOM_EMPTY_GRACE_MS?: string;
    readonly ROOM_PURGE_DELAY_MS?: string;
    readonly ROOM_MAX_CONTENT_BYTES?: string;
    readonly ROOM_MAX_GAMES?: string;
    readonly ROOM_MAX_LIFETIME_MS?: string;
    readonly JEV_API_KEY?: string;
    readonly JEV_DAILY_ATTEMPT_CAP?: string;
    readonly GENERATION_DAILY_ATTEMPTS?: string;
  };

  // Runs `callback(instance, ctx)` inside the Durable Object's own context.
  export function runInDurableObject<T>(
    stub: DurableObjectStub<Room>,
    callback: (instance: Room, ctx: DurableObjectState) => T | Promise<T>,
  ): Promise<T>;

  // Delivers the scheduled alarm exactly like workerd would (returns false
  // when no alarm is set).
  export function runDurableObjectAlarm(stub: DurableObjectStub<Room>): Promise<boolean>;

  export function evictDurableObject(
    stub: DurableObjectStub<Room>,
    options?: { readonly shutdown?: boolean },
  ): Promise<void>;
}
