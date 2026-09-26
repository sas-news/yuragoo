// Minimal structured ops logging (Task 38): one JSON line per event over
// console.log. The OpsEvent shape is a deliberate allowlist — ops data
// only: which code path, how slow (coarse bucket), what kind of failure,
// token counts, model id. NOTHING user-shaped is representable: never
// log request bodies, room/user identifiers, URL queries, secrets or
// free text (caller-side error strings are all fixed enum codes).

export type LatencyBucket = "<1s" | "1-3s" | "3-10s" | ">10s";

export interface OpsEvent {
  readonly eventCode: string; // fixed vocabulary, e.g. "jev-decision"
  readonly modelVersion?: string | undefined; // e.g. "jev-1.13.0"
  readonly latencyBucket?: LatencyBucket | undefined; // never raw ms
  readonly errorKind?: string | undefined; // e.g. "timeout" / "http-503"
  readonly usage?:
    | {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
      }
    | undefined;
}

// Coarse latency classes only — raw ms would be a per-request side
// channel; a bucket is enough for trend/alerting.
export const latencyBucket = (elapsedMs: number): LatencyBucket =>
  elapsedMs < 1_000 ? "<1s" : elapsedMs < 3_000 ? "1-3s" : elapsedMs < 10_000 ? "3-10s" : ">10s";

// Whitelist hygiene: a caller-supplied string that is not a plain code
// token collapses to "unknown" instead of leaking through to the log.
const CODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const code = (value: string | undefined): string =>
  value !== undefined && CODE_RE.test(value) ? value : "unknown";

const nonNegInt = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const logEvent = (input: OpsEvent): void => {
  const usage =
    input.usage === undefined
      ? undefined
      : {
          inputTokens: nonNegInt(input.usage.inputTokens),
          outputTokens: nonNegInt(input.usage.outputTokens),
        };
  console.log(
    JSON.stringify({
      eventCode: code(input.eventCode),
      modelVersion: input.modelVersion === undefined ? undefined : code(input.modelVersion),
      latencyBucket: input.latencyBucket,
      errorKind: input.errorKind === undefined ? undefined : code(input.errorKind),
      usage,
    }),
  );
};
