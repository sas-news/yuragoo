// Pure outbound HTTP policy for the JEV provider: fixed endpoint, retryable
// status classification, Retry-After parsing and the strict deadline check.
// No timers or network here — the provider supplies concrete values.
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const checkFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
};

export const isRetriableStatus = (status: number): boolean =>
  Number.isFinite(status) && (status === 429 || status === 529 || (status >= 500 && status <= 599));

// Retry-After accepts delta-seconds or an HTTP-date; anything else (or a date
// already in the past) resolves to 0 so the retry decision stays explicit.
export const retryAfterMs = (value: string | null, nowMs: number): number => {
  checkFinite(nowMs, "nowMs");
  if (value === null) return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return 0;
  return Math.max(0, dateMs - nowMs);
};

export const canRetryBeforeDeadline = (
  nowMs: number,
  delayMs: number,
  deadlineMs: number,
): boolean => {
  checkFinite(nowMs, "nowMs");
  checkFinite(delayMs, "delayMs");
  checkFinite(deadlineMs, "deadlineMs");
  return nowMs + delayMs < deadlineMs;
};
