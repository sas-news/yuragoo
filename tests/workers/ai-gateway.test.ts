// AI dev-gateway worker tests running inside the real workerd pool. The
// outbound wire is mocked only at the injected fetch boundary; provider,
// parsing and quota logic always run for real.
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  canRetryBeforeDeadline,
  defaultSleep,
  InMemoryAttemptQuota,
  isRetriableStatus,
  JevDecisionProvider,
  retryAfterMs,
} from "@yuragoo/ai";
import { parseDecisionState } from "@yuragoo/protocol";
import {
  createLocalApp,
  createProductionApp,
  type DevGatewayDeps,
} from "../../apps/server/src/dev-gateway";
import {
  BINDINGS,
  countingFetch,
  hangingFetch,
  okResponse,
  post,
  SESSION,
  STATE,
  statusResponse,
  type SendRecord,
} from "./gateway-helpers";

interface GatewaySuccess {
  result: {
    selectedChoiceId: string;
    usage: { inputTokens: number; outputTokens: number };
    distribution: { choiceId: string; probability: number }[];
  };
  attempts: { dailyAttempts: number; sessionAttempts: number };
}
const app = (deps: DevGatewayDeps, cap = "1000") =>
  createLocalApp({ ...BINDINGS, JEV_DAILY_ATTEMPT_CAP: cap }, deps);
const provider = (fetch: typeof globalThis.fetch, timeoutMs = 500) =>
  new JevDecisionProvider({
    apiKey: BINDINGS.JEV_API_KEY,
    sessionId: SESSION,
    quota: new InMemoryAttemptQuota({ dailyAttemptCap: 1000, perSessionAttemptCap: 120 }),
    timeoutMs,
    fetch,
    nowMs: () => Date.now(),
    sleep: defaultSleep,
  });
const state = () => parseDecisionState(STATE);

test("happy: official response flows through with usage and one attempt", async () => {
  // Given a local app wired to an official-shaped upstream response
  const sent: SendRecord[] = [];
  const res = await post(app({ fetch: countingFetch(sent, () => okResponse()) }));
  // Then the result, camel-cased usage and a counts-only snapshot return, and
  // the outbound call carried an Authorization header (value never logged)
  expect(res.status).toBe(200);
  const body = (await res.json()) as GatewaySuccess;
  expect(body.result.selectedChoiceId).toBe("a");
  expect(body.result.usage).toEqual({ inputTokens: 11, outputTokens: 9 });
  expect(body.result.distribution[0]?.probability).toBeCloseTo(0.7, 6);
  expect(body.attempts).toEqual({ dailyAttempts: 1, sessionAttempts: 1 });
  expect(sent.length).toBe(1);
  expect(sent[0]?.hasAuthHeader).toBe(true);
});

test("failure: non-retriable statuses send exactly once", async () => {
  // 401 maps to auth/502, 422 and other 4xx to invalid-request/422
  const cases = [
    [401, "auth", 502],
    [422, "invalid-request", 422],
    [404, "invalid-request", 422],
  ] as const;
  for (const [status, error, expected] of cases) {
    const sent: SendRecord[] = [];
    const res = await post(app({ fetch: countingFetch(sent, () => statusResponse(status)) }));
    expect(res.status).toBe(expected);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    expect(sent.length).toBe(1);
  }
  // A malformed 2xx body is invalid-response/502 and never retries
  const bad: SendRecord[] = [];
  const res = await post(
    app({ fetch: countingFetch(bad, () => new Response("{", { status: 200 })) }),
  );
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe("invalid-response");
  expect(bad.length).toBe(1);
});

test("happy: retriable statuses and network errors retry once", async () => {
  for (const status of [429, 529, 500]) {
    const sent: SendRecord[] = [];
    const fetch = countingFetch(sent, (call) =>
      call === 1 ? statusResponse(status) : okResponse(),
    );
    const res = await post(app({ fetch }));
    expect(res.status).toBe(200);
    expect(sent.length).toBe(2);
    const body = (await res.json()) as GatewaySuccess;
    expect(body.attempts).toEqual({ dailyAttempts: 2, sessionAttempts: 2 });
  }
  const sent: SendRecord[] = [];
  const fetch = countingFetch(sent, (call) =>
    call === 1 ? Promise.reject(new TypeError("socket reset")) : okResponse(),
  );
  const res = await post(app({ fetch }));
  expect(res.status).toBe(200);
  expect(sent.length).toBe(2);
});

test("failure: Retry-After beyond the deadline forbids a second send", async () => {
  // Given a 429 with a 10s Retry-After against the 3s gateway timeout, Then no
  // sleep/retry happens and rate-limit maps to 429
  const sent: SendRecord[] = [];
  const res = await post(app({ fetch: countingFetch(sent, () => statusResponse(429, "10")) }));
  expect(res.status).toBe(429);
  expect(((await res.json()) as { error: string }).error).toBe("rate-limit");
  expect(sent.length).toBe(1);
});

test("happy: short or malformed Retry-After retries within the deadline", async () => {
  for (const retryAfter of ["0", "not-a-date"]) {
    const sent: SendRecord[] = [];
    const fetch = countingFetch(sent, (call) =>
      call === 1 ? statusResponse(429, retryAfter) : okResponse(),
    );
    expect((await post(app({ fetch }))).status).toBe(200);
    expect(sent.length).toBe(2);
  }
  const sent: SendRecord[] = [];
  const fetch = countingFetch(sent, (call) =>
    call === 1 ? statusResponse(429, new Date(Date.now() + 1000).toUTCString()) : okResponse(),
  );
  expect((await post(app({ fetch }))).status).toBe(200);
  expect(sent.length).toBe(2);
});

test("failure: missing config yields 503 and zero sends", async () => {
  for (const bindings of [
    { APP_ENV: "local" },
    { APP_ENV: "local", JEV_API_KEY: "test-placeholder-key" },
    { APP_ENV: "local", JEV_API_KEY: "k", JEV_DAILY_ATTEMPT_CAP: "0" },
  ]) {
    const sent: SendRecord[] = [];
    const res = await post(createLocalApp(bindings, { fetch: countingFetch(sent, okResponse) }));
    expect(res.status).toBe(503);
    expect(sent.length).toBe(0);
  }
});

test("failure: dev route is absent in production and refuses non-loopback", async () => {
  const sent: SendRecord[] = [];
  const deps = { fetch: countingFetch(sent, okResponse) };
  expect((await post(createProductionApp())).status).toBe(404);
  expect((await post(SELF)).status).toBe(404);
  expect((await post(createLocalApp(BINDINGS, deps), "evil.example")).status).toBe(404);
  expect(sent.length).toBe(0);
  expect((await SELF.fetch("http://localhost/api/health")).status).toBe(200);
});

test("failure: the session cap stops the 121st send", async () => {
  const sent: SendRecord[] = [];
  const target = app({ fetch: countingFetch(sent, () => okResponse()) });
  for (let i = 0; i < 120; i += 1) expect((await post(target)).status).toBe(200);
  expect(sent.length).toBe(120);
  const res = await post(target);
  expect(res.status).toBe(429);
  expect(((await res.json()) as { error: string }).error).toBe("quota");
  expect(sent.length).toBe(120);
});

test("failure: concurrent requests share the daily cap atomically", async () => {
  const sent: SendRecord[] = [];
  const target = app({ fetch: countingFetch(sent, () => okResponse()) }, "3");
  const results = await Promise.all(Array.from({ length: 6 }, () => post(target)));
  expect(sent.length).toBe(3);
  expect(results.filter((r) => r.status === 200).length).toBe(3);
  expect(results.filter((r) => r.status === 429).length).toBe(3);
});

test("failure: external abort never sends and discards late results", async () => {
  const sent: SendRecord[] = [];
  await expect(
    provider(countingFetch(sent, () => okResponse())).evaluate(state(), AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(sent.length).toBe(0);
  const mid = new AbortController();
  const inFlight: SendRecord[] = [];
  const pending = provider(hangingFetch(inFlight)).evaluate(state(), mid.signal);
  mid.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(inFlight.length).toBe(1);
  const late = new AbortController();
  const lateSent: SendRecord[] = [];
  const aborting = countingFetch(lateSent, () => {
    late.abort();
    return okResponse();
  });
  await expect(provider(aborting).evaluate(state(), late.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(lateSent.length).toBe(1);
});

test("failure: a deadline timeout maps to the timeout kind without retry", async () => {
  const sent: SendRecord[] = [];
  await expect(provider(hangingFetch(sent), 40).evaluate(state())).rejects.toMatchObject({
    name: "JevProviderError",
    kind: "timeout",
  });
  expect(sent.length).toBe(1);
});

test("failure: responses never echo the configured secret", async () => {
  const sent: SendRecord[] = [];
  const res = await post(app({ fetch: countingFetch(sent, () => statusResponse(401)) }));
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain(BINDINGS.JEV_API_KEY);
});

test("happy: pure policy edges for statuses, Retry-After and deadlines", () => {
  for (const s of [429, 529, 500, 503, 599]) expect(isRetriableStatus(s)).toBe(true);
  for (const s of [200, 301, 400, 401, 404, 422]) expect(isRetriableStatus(s)).toBe(false);
  expect(retryAfterMs(null, 1000)).toBe(0);
  expect(retryAfterMs("3", 1000)).toBe(3000);
  expect(retryAfterMs("bogus", 1000)).toBe(0);
  expect(retryAfterMs(new Date(500).toUTCString(), 1000)).toBe(0);
  expect(canRetryBeforeDeadline(0, 999, 1000)).toBe(true);
  expect(canRetryBeforeDeadline(0, 1000, 1000)).toBe(false);
});

test("happy: quota rolls UTC days and validates caps, ids and clocks", () => {
  const day = Date.UTC(2026, 0, 1);
  const quota = new InMemoryAttemptQuota({ dailyAttemptCap: 2, perSessionAttemptCap: 1 });
  expect(quota.reserve("session-0001", day).dailyAttempts).toBe(1);
  expect(quota.reserve("session-0002", day).sessionAttempts).toBe(1);
  expect(() => quota.reserve("session-0003", day)).toThrowError(/daily/);
  // A new UTC day resets both counters
  expect(quota.reserve("session-0001", day + 86_400_000).sessionAttempts).toBe(1);
  expect(() => quota.reserve("bad id!", day)).toThrow(RangeError);
  expect(() => quota.snapshot("session-0001", Number.NaN)).toThrow(RangeError);
  expect(() => new InMemoryAttemptQuota({ dailyAttemptCap: 0, perSessionAttemptCap: 1 })).toThrow(
    RangeError,
  );
});
