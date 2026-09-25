// Dev-gateway CORS: loopback browser origins (vite dev / preview) get an
// allow-origin echo on preflight and on responses; any foreign origin gets
// nothing, and the production app never mounts the middleware at all.
import { expect, test } from "vitest";
import { createLocalApp, createProductionApp } from "../../apps/server/src/dev-gateway";
import { BINDINGS, countingFetch, okResponse, post, SESSION, STATE } from "./gateway-helpers";

const preflight = (
  app: { fetch(request: Request): Promise<Response> | Response },
  origin: string,
): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request("http://localhost:8787/api/dev/jev/evaluate", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    ),
  );

test("happy: loopback preflights get allow-origin, foreign ones do not", async () => {
  const target = createLocalApp(BINDINGS, { fetch: countingFetch([], () => okResponse()) });
  for (const origin of [
    "http://localhost:4173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://[::1]:5173",
  ]) {
    const res = await preflight(target, origin);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  }
  for (const origin of ["https://evil.example", "http://evil.example", "null"]) {
    const res = await preflight(target, origin);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
});

test("happy: loopback origin is echoed on the POST response itself", async () => {
  const target = createLocalApp(BINDINGS, { fetch: countingFetch([], () => okResponse()) });
  const res = await post(target);
  expect(res.headers.get("access-control-allow-origin")).toBeNull(); // no Origin header sent
  const withOrigin = await Promise.resolve(
    target.fetch(
      new Request("http://localhost:8787/api/dev/jev/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4173" },
        body: JSON.stringify({ sessionId: SESSION, state: STATE }),
      }),
    ),
  );
  expect(withOrigin.headers.get("access-control-allow-origin")).toBe("http://localhost:4173");
});

test("failure: production app carries no dev CORS middleware", async () => {
  const res = await preflight(createProductionApp(), "http://localhost:4173");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.status).toBe(404);
});
