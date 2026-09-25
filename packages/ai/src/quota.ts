// In-memory attempt quota for outbound AI calls. All counters live in the
// isolate: reserve() is synchronous and atomic, so concurrent async callers
// can never exceed the configured caps. Consumed attempts are never rolled
// back — a failed or retried send still counts.
export interface AttemptQuotaConfig {
  readonly dailyAttemptCap: number;
  readonly perSessionAttemptCap: number;
}

export interface AttemptQuotaSnapshot {
  readonly utcDay: string;
  readonly dailyAttempts: number;
  readonly sessionAttempts: number;
}

export type QuotaScope = "daily" | "session";

export class QuotaExceededError extends Error {
  readonly scope: QuotaScope;

  constructor(scope: QuotaScope) {
    super(`attempt quota exceeded: ${scope}`);
    this.name = "QuotaExceededError";
    this.scope = scope;
  }
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

const checkCap = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};
// Largest timestamp Date can represent; toISOString would throw RangeError
// above it anyway, so reject early with the same stable error shape.
const MAX_UTC_MS = 8_640_000_000_000_000;
const checkNow = (nowMs: number): void => {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_UTC_MS) {
    throw new RangeError("nowMs must be finite and within the UTC Date range");
  }
};
const checkSession = (sessionId: string): void => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new RangeError("sessionId must match /^[a-zA-Z0-9_-]{8,64}$/");
  }
};

export class InMemoryAttemptQuota {
  private readonly config: AttemptQuotaConfig;
  private day = "";
  private dailyAttempts = 0;
  private readonly sessions = new Map<string, number>();

  constructor(config: AttemptQuotaConfig) {
    checkCap(config.dailyAttemptCap, "dailyAttemptCap");
    checkCap(config.perSessionAttemptCap, "perSessionAttemptCap");
    this.config = config;
  }

  private rollDay(nowMs: number): void {
    checkNow(nowMs);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dailyAttempts = 0;
      this.sessions.clear();
    }
  }

  reserve(sessionId: string, nowMs: number): AttemptQuotaSnapshot {
    this.rollDay(nowMs);
    checkSession(sessionId);
    if (this.dailyAttempts >= this.config.dailyAttemptCap) {
      throw new QuotaExceededError("daily");
    }
    const sessionAttempts = this.sessions.get(sessionId) ?? 0;
    if (sessionAttempts >= this.config.perSessionAttemptCap) {
      throw new QuotaExceededError("session");
    }
    this.dailyAttempts += 1;
    this.sessions.set(sessionId, sessionAttempts + 1);
    return {
      utcDay: this.day,
      dailyAttempts: this.dailyAttempts,
      sessionAttempts: sessionAttempts + 1,
    };
  }

  snapshot(sessionId: string, nowMs: number): AttemptQuotaSnapshot {
    this.rollDay(nowMs);
    checkSession(sessionId);
    return {
      utcDay: this.day,
      dailyAttempts: this.dailyAttempts,
      sessionAttempts: this.sessions.get(sessionId) ?? 0,
    };
  }
}
