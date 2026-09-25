// Active-room registry calls (Task 22): GameRoom registers on create and
// revokes on close — bookkeeping only, never a gate for gameplay, so every
// call rides ctx.waitUntil and swallows its own failures.
import { CONTROL_PLANE_NAME, type ControlPlane } from "../control/ControlPlane";
import type { ServerBindings } from "../config";

const controlStub = (env: ServerBindings): DurableObjectStub<ControlPlane> | null => {
  const ns = env.CONTROL_PLANE;
  return ns === undefined ? null : ns.get(ns.idFromName(CONTROL_PLANE_NAME));
};

// Swallow-on-purpose: the registry is best-effort bookkeeping — a slow or
// unreachable ControlPlane must never block or fail room lifecycle work.
const ignore = <T>(_v: T): void => {};
const ignoreErr = (_e: unknown): void => {};

export const registerActiveRoom = (
  ctx: Pick<DurableObjectState, "waitUntil">,
  env: ServerBindings,
  roomId: string,
): void => {
  const stub = controlStub(env);
  if (stub === null) return;
  ctx.waitUntil(stub.registerRoom({ roomId, nowMs: Date.now() }).then(ignore, ignoreErr));
};

export const revokeActiveRoom = (
  ctx: Pick<DurableObjectState, "waitUntil">,
  env: ServerBindings,
  roomId: string,
): void => {
  const stub = controlStub(env);
  if (stub === null) return;
  ctx.waitUntil(stub.revokeRoom({ roomId }).then(ignore, ignoreErr));
};
