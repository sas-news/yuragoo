// Single-flight evaluation scheduler: buffers accepted inputs, starts one
// job when debounce or maxWait elapses, requeues timed-out work ahead of
// newer pending inputs and ignores stale tokens across epochs. All timing
// comes from an injected clock — no timers, globals or provider calls here.
import { ContextContractError } from "./context";

export interface SchedulerClock {
  nowMs(): number;
}

export interface SchedulerConfig {
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly timeoutMs: number;
  readonly maxPending: number;
  readonly maxPendingBytes: number;
}

export interface EvaluationInput {
  readonly inputSeq: number;
  readonly byteLength: number;
  readonly acceptedAtMs: number;
}

export interface JobToken {
  readonly epoch: number;
  readonly jobId: number;
}

export interface EvaluationJob {
  readonly token: JobToken;
  readonly cutoffSeq: number;
  readonly inputs: readonly EvaluationInput[];
  readonly startedAtMs: number;
  readonly deadlineMs: number;
}

export interface SchedulerSnapshot {
  readonly epoch: number;
  readonly state: "open" | "closed";
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly inFlight: JobToken | null;
  readonly lastAppliedCutoff: number;
}

export class SchedulerBackpressureError extends Error {
  readonly reason: "count" | "bytes";

  constructor(reason: "count" | "bytes") {
    super(`pending backpressure: ${reason}`);
    this.name = "SchedulerBackpressureError";
    this.reason = reason;
  }
}

const checkConfig = (config: SchedulerConfig): void => {
  const nonnegative = (v: number, name: string): void => {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`${name} must be a nonnegative safe integer`);
    }
  };
  const positive = (v: number, name: string): void => {
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  };
  nonnegative(config.debounceMs, "debounceMs");
  nonnegative(config.maxWaitMs, "maxWaitMs");
  positive(config.timeoutMs, "timeoutMs");
  positive(config.maxPending, "maxPending");
  positive(config.maxPendingBytes, "maxPendingBytes");
};

export class EvaluationScheduler {
  private readonly config: SchedulerConfig;
  private readonly clock: SchedulerClock;
  private epoch = 0;
  private closed = false;
  private pending: EvaluationInput[] = [];
  private pendingBytes = 0;
  private inFlight: EvaluationJob | null = null;
  private lastAppliedCutoff = 0;
  private maxSeq = 0;
  private jobCounter = 0;
  private lastNow = Number.NEGATIVE_INFINITY;

  constructor(config: SchedulerConfig, clock: SchedulerClock) {
    checkConfig(config);
    if (typeof clock?.nowMs !== "function") {
      throw new TypeError("clock must provide nowMs()");
    }
    this.config = config;
    this.clock = clock;
  }

  private now(): number {
    const t = this.clock.nowMs();
    if (!Number.isFinite(t)) {
      throw new RangeError("clock nowMs() must return a finite number");
    }
    if (t < this.lastNow) {
      throw new RangeError("clock nowMs() moved backward");
    }
    this.lastNow = t;
    return t;
  }

  private clearWork(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.inFlight = null;
    this.maxSeq = 0;
  }

  accept(input: EvaluationInput): void {
    if (this.closed) {
      throw new ContextContractError("scheduler is closed");
    }
    if (!Number.isSafeInteger(input.inputSeq) || input.inputSeq < 1) {
      throw new ContextContractError("inputSeq must be a safe integer >= 1");
    }
    if (input.inputSeq <= this.maxSeq) {
      throw new ContextContractError("inputSeq must strictly increase within an epoch");
    }
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
      throw new ContextContractError("byteLength must be a nonnegative safe integer");
    }
    if (!Number.isFinite(input.acceptedAtMs) || input.acceptedAtMs < 0) {
      throw new ContextContractError("acceptedAtMs must be finite and >= 0");
    }
    if (input.acceptedAtMs > this.now()) {
      throw new ContextContractError("acceptedAtMs cannot be in the future");
    }
    // Backpressure is enforced before any mutation so a rejected input
    // leaves the pending window untouched.
    if (this.pending.length + 1 > this.config.maxPending) {
      throw new SchedulerBackpressureError("count");
    }
    if (this.pendingBytes + input.byteLength > this.config.maxPendingBytes) {
      throw new SchedulerBackpressureError("bytes");
    }
    this.pending.push(input);
    this.pendingBytes += input.byteLength;
    this.maxSeq = input.inputSeq;
  }

  // Event-driven start: a job may begin once now reaches the earlier of the
  // debounce edge (moved by each new arrival) and the maxWait edge (pinned to
  // the oldest pending input, so continuous arrivals can never starve it).
  poll(): EvaluationJob | null {
    if (this.closed || this.inFlight !== null || this.pending.length === 0) {
      return null;
    }
    const t = this.now();
    const dirtySince = Math.min(...this.pending.map((i) => i.acceptedAtMs));
    const lastAccepted = Math.max(...this.pending.map((i) => i.acceptedAtMs));
    const startAt = Math.min(
      lastAccepted + this.config.debounceMs,
      dirtySince + this.config.maxWaitMs,
    );
    if (t < startAt) return null;
    const inputs = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.jobCounter += 1;
    this.inFlight = {
      token: { epoch: this.epoch, jobId: this.jobCounter },
      cutoffSeq: inputs[inputs.length - 1]?.inputSeq ?? 0,
      inputs,
      startedAtMs: t,
      deadlineMs: t + this.config.timeoutMs,
    };
    return this.inFlight;
  }

  resolve(token: JobToken): { readonly applied: boolean; readonly cutoffSeq: number | null } {
    if (
      this.inFlight === null ||
      token.epoch !== this.epoch ||
      token.jobId !== this.inFlight.token.jobId
    ) {
      return { applied: false, cutoffSeq: null };
    }
    const cutoff = this.inFlight.cutoffSeq;
    this.inFlight = null;
    this.lastAppliedCutoff = Math.max(this.lastAppliedCutoff, cutoff);
    return { applied: true, cutoffSeq: cutoff };
  }

  timeout(): JobToken | null {
    if (this.inFlight === null || this.now() < this.inFlight.deadlineMs) {
      return null;
    }
    const job = this.inFlight;
    this.inFlight = null;
    // Requeue the dead job's inputs ahead of pending, dedup by seq, so the
    // next job covers both the timed-out and the newer inputs.
    const merged = new Map<number, EvaluationInput>();
    for (const i of job.inputs) merged.set(i.inputSeq, i);
    for (const i of this.pending) merged.set(i.inputSeq, i);
    this.pending = [...merged.values()].sort((a, b) => a.inputSeq - b.inputSeq);
    this.pendingBytes = this.pending.reduce((sum, i) => sum + i.byteLength, 0);
    return job.token;
  }

  reset(): void {
    this.epoch += 1;
    this.clearWork();
    this.lastAppliedCutoff = 0;
    this.closed = false;
  }

  close(): void {
    this.epoch += 1;
    this.clearWork();
    this.closed = true;
  }

  snapshot(): SchedulerSnapshot {
    return {
      epoch: this.epoch,
      state: this.closed ? "closed" : "open",
      pendingCount: this.pending.length,
      pendingBytes: this.pendingBytes,
      inFlight: this.inFlight === null ? null : { ...this.inFlight.token },
      lastAppliedCutoff: this.lastAppliedCutoff,
    };
  }
}
