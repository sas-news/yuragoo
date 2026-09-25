// JEV decision provider: posts a Task-7 request envelope to the fixed
// TypeSafe endpoint with a bearer key, one optional retry, shared attempt
// quota accounting and a strict overall deadline.
import ky from "ky";
import {
  createDecisionEnvelope,
  DecisionContractError,
  type DecisionResult,
  type DecisionState,
  parseJevDecisionResponse,
} from "@yuragoo/protocol";
import {
  canRetryBeforeDeadline,
  isRetriableStatus,
  JEV_ENDPOINT,
  retryAfterMs,
} from "./http-policy";
import type { DecisionProvider } from "./provider";
import { InMemoryAttemptQuota, QuotaExceededError } from "./quota";

export type JevErrorKind =
  | "auth"
  | "invalid-request"
  | "rate-limit"
  | "upstream"
  | "timeout"
  | "quota"
  | "invalid-response";

export class JevProviderError extends Error {
  readonly kind: JevErrorKind;
  readonly retryable: boolean;

  constructor(kind: JevErrorKind, retryable: boolean, message: string) {
    super(message);
    this.name = "JevProviderError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface JevProviderOptions {
  readonly apiKey: string;
  readonly sessionId: string;
  readonly quota: InMemoryAttemptQuota;
  readonly timeoutMs: number;
  readonly fetch: typeof globalThis.fetch;
  readonly nowMs: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Outbound wire call used in production: ky with retries and its own timeout
// fully disabled — the provider owns the deadline and retry policy.
export const jevOutboundFetch: typeof globalThis.fetch = Object.assign(
  (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
    ky(input, { ...init, retry: 0, timeout: false, throwHttpErrors: false }),
  { preconnect: () => {} },
);

// Abortable delay used when no sleep implementation is injected.
export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const providerError = (kind: JevErrorKind, retryable: boolean, message: string) =>
  new JevProviderError(kind, retryable, message);
const timeoutError = () => providerError("timeout", true, "request exceeded the deadline");

export class JevDecisionProvider implements DecisionProvider {
  private readonly options: JevProviderOptions;

  constructor(options: JevProviderOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new RangeError("apiKey must be a nonempty string");
    }
    if (!SESSION_ID_PATTERN.test(options.sessionId)) {
      throw new RangeError("sessionId must match /^[a-zA-Z0-9_-]{8,64}$/");
    }
    if (!(options.quota instanceof InMemoryAttemptQuota)) {
      throw new TypeError("quota must be an InMemoryAttemptQuota");
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }
    for (const [name, fn] of [
      ["fetch", options.fetch],
      ["nowMs", options.nowMs],
      ["sleep", options.sleep],
    ] as const) {
      if (typeof fn !== "function") throw new TypeError(`${name} must be a function`);
    }
    // A padded key is normalized once so the bearer header never carries it.
    this.options = { ...options, apiKey: options.apiKey.trim() };
  }

  private reserve(): void {
    try {
      this.options.quota.reserve(this.options.sessionId, this.options.nowMs());
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        throw providerError("quota", false, `attempt quota exceeded: ${error.scope}`);
      }
      throw error;
    }
  }

  private async send(bodyJson: string, signal: AbortSignal): Promise<Response> {
    return this.options.fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: bodyJson,
      signal,
    });
  }

  async evaluate(state: DecisionState, signal?: AbortSignal): Promise<DecisionResult> {
    signal?.throwIfAborted();
    const { nowMs, sleep } = this.options;
    const envelope = createDecisionEnvelope(state, nowMs());
    const deadline = nowMs() + this.options.timeoutMs;
    const bodyJson = JSON.stringify(envelope.body);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      const now = nowMs();
      if (now >= deadline) throw timeoutError();
      // The reservation is atomic and must precede every outbound send; a
      // quota failure means zero additional fetch invocations.
      this.reserve();
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new DOMException("deadline", "TimeoutError")),
        Math.max(1, deadline - now),
      );
      try {
        const response = await this.send(bodyJson, controller.signal);
        const status = response.status;
        if (status >= 200 && status < 300) {
          let result: DecisionResult;
          try {
            result = parseJevDecisionResponse(await response.json(), envelope);
          } catch (error) {
            const name = error instanceof DOMException ? error.name : "";
            if (signal?.aborted || name === "AbortError" || name === "TimeoutError") throw error;
            // Malformed JSON or a contract violation never retries.
            throw providerError("invalid-response", false, "upstream response failed validation");
          }
          // Discard a result that arrived after external abort or the deadline.
          signal?.throwIfAborted();
          if (nowMs() >= deadline) throw timeoutError();
          return result;
        }
        if (status === 401) throw providerError("auth", false, "upstream rejected credentials");
        if (status >= 400 && status < 500 && status !== 429) {
          throw providerError("invalid-request", false, `upstream rejected request (${status})`);
        }
        const kind = status === 429 ? "rate-limit" : "upstream";
        const retriable = isRetriableStatus(status);
        const at = nowMs();
        const delay = retryAfterMs(response.headers.get("retry-after"), at);
        if (attempt === 0 && retriable && canRetryBeforeDeadline(at, delay, deadline)) {
          await sleep(delay, controller.signal);
          continue;
        }
        throw providerError(kind, retriable, `upstream responded ${status}`);
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("aborted", "AbortError");
        }
        if (error instanceof JevProviderError) throw error;
        if (error instanceof DecisionContractError) {
          throw providerError("invalid-response", false, "upstream response failed validation");
        }
        const name = error instanceof DOMException ? error.name : "";
        // Anything arriving after the deadline — including a fetch that maps
        // the deadline abort to a bare AbortError — is a timeout, never a leak.
        if (nowMs() >= deadline) throw timeoutError();
        if (name === "AbortError") throw error;
        // An early timeout or transport failure may retry once while the
        // deadline still has room; a second timeout maps to the timeout kind.
        if (attempt === 0 && canRetryBeforeDeadline(nowMs(), 0, deadline)) continue;
        if (name === "TimeoutError") throw timeoutError();
        throw providerError("upstream", true, "upstream request failed");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onExternalAbort);
      }
    }
    throw providerError("upstream", true, "attempts exhausted");
  }
}
