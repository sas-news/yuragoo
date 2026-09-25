// Provider/quota edge cases in the workerd pool: abortable sleep hygiene,
// clock-range validation, padded-key normalization and the native-fetch
// AbortError-at-deadline mapping.
import { expect, test } from "vitest";
import { defaultSleep, InMemoryAttemptQuota, JevDecisionProvider } from "@yuragoo/ai";
import { parseDecisionState } from "@yuragoo/protocol";
import {
  BINDINGS,
  countingFetch,
  okResponse,
  SESSION,
  STATE,
  type SendRecord,
} from "./gateway-helpers";

const provider = (fetch: typeof globalThis.fetch, timeoutMs = 500, apiKey = BINDINGS.JEV_API_KEY) =>
  new JevDecisionProvider({
    apiKey,
    sessionId: SESSION,
    quota: new InMemoryAttemptQuota({ dailyAttemptCap: 1000, perSessionAttemptCap: 120 }),
    timeoutMs,
    fetch,
    nowMs: () => Date.now(),
    sleep: defaultSleep,
  });
const state = () => parseDecisionState(STATE);

test("failure: defaultSleep rejects immediately on an already-aborted signal", async () => {
  // Given an aborted signal, Then no timer wait happens
  const t0 = Date.now();
  await expect(defaultSleep(60_000, AbortSignal.abort())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("happy: defaultSleep removes its abort listener once the timer resolves", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;
  signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    added += 1;
    return add(type, listener as EventListener, options as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: unknown) => {
    removed += 1;
    return remove(type, listener as EventListener);
  }) as typeof signal.removeEventListener;
  await defaultSleep(0, signal);
  expect(added).toBe(1);
  expect(removed).toBe(1);
});

test("failure: quota rejects clocks beyond the JS UTC Date range", () => {
  const quota = new InMemoryAttemptQuota({ dailyAttemptCap: 5, perSessionAttemptCap: 5 });
  expect(() => quota.snapshot("session-0001", 8_640_000_000_000_001)).toThrow(RangeError);
  expect(() => quota.reserve("session-0001", Number.MAX_VALUE)).toThrow(RangeError);
  // The exact boundary timestamp still works
  expect(quota.reserve("session-0001", 8_640_000_000_000_000).dailyAttempts).toBe(1);
});

test("happy: a padded api key is normalized before the outbound send", async () => {
  const sent: SendRecord[] = [];
  await provider(
    countingFetch(sent, () => okResponse()),
    500,
    "  padded-key  ",
  ).evaluate(state());
  expect(sent.length).toBe(1);
  const auth = sent[0]?.authorization ?? "";
  // The header exists and carries no padding; its value is never logged.
  expect(auth.startsWith("Bearer ")).toBe(true);
  expect(auth.includes("  ")).toBe(false);
});

test("failure: a fetch rejecting bare AbortError at the deadline maps to timeout", async () => {
  // Native fetch rejects AbortError regardless of the abort reason; when the
  // provider's own deadline fired, that must surface as kind:"timeout".
  const sent: SendRecord[] = [];
  const abortAtSignal = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), authorization: null, hasAuthHeader: false });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
  await expect(provider(abortAtSignal, 40).evaluate(state())).rejects.toMatchObject({
    name: "JevProviderError",
    kind: "timeout",
  });
  expect(sent.length).toBe(1);
});
