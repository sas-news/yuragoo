// Shared fixtures for Task 9 scheduling/context tests: a mutable fake clock,
// input/message factories and distribution builders. No real time or I/O.
import type {
  AcceptedMessage,
  EvaluationInput,
  EvaluationJob,
  SchedulerClock,
  SchedulerConfig,
} from "@yuragoo/ai";
import { parseChoiceId, type DecisionDistribution } from "@yuragoo/protocol";

export class FakeClock implements SchedulerClock {
  t = 0;
  nowMs(): number {
    return this.t;
  }
}

export const cfg = (over: Partial<SchedulerConfig> = {}): SchedulerConfig => ({
  debounceMs: 0,
  maxWaitMs: 1000,
  timeoutMs: 100,
  maxPending: 48,
  maxPendingBytes: 1_000_000,
  ...over,
});

export const invalidCfgs: readonly Partial<SchedulerConfig>[] = [
  { debounceMs: -1 },
  { timeoutMs: 0 },
  { maxPending: 0 },
  { maxPendingBytes: 0 },
  { maxWaitMs: Number.NaN },
];

export const input = (seq: number, over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  inputSeq: seq,
  byteLength: 1,
  acceptedAtMs: 0,
  ...over,
});

export const msg = (seq: number, over: Partial<AcceptedMessage> = {}): AcceptedMessage => ({
  inputSeq: seq,
  messageId: `m${seq}`,
  playerId: "p1",
  choiceId: parseChoiceId("a"),
  text: `t${seq}`,
  acceptedAtMs: seq,
  impact: 0.5,
  persistent: false,
  ...over,
});

export const dist = (pairs: readonly (readonly [string, number])[]): DecisionDistribution[] =>
  pairs.map(([id, probability]) => ({ choiceId: parseChoiceId(id), probability }));

export const mustJob = (job: EvaluationJob | null): EvaluationJob => {
  if (job === null) throw new Error("expected a job");
  return job;
};
