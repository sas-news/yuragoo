// Generates Task 9 evidence: drives EvaluationScheduler through a fake-clock
// scenario (burst, in-flight accepts, timeout+requeue, late resolve) and
// writes the observable event/snapshot timeline as JSON.
import { writeFileSync } from "node:fs";
import { EvaluationScheduler, type SchedulerClock } from "@yuragoo/ai";

const clock: SchedulerClock & { t: number } = {
  t: 0,
  nowMs() {
    return this.t;
  },
};
const s = new EvaluationScheduler(
  { debounceMs: 50, maxWaitMs: 1000, timeoutMs: 100, maxPending: 48, maxPendingBytes: 1_000_000 },
  clock,
);
const events: unknown[] = [];
const snap = (label: string) => events.push({ at: clock.t, event: label, snapshot: s.snapshot() });
const input = (seq: number, at: number) => ({ inputSeq: seq, byteLength: 10, acceptedAtMs: at });

// 6-player burst at t=0; job starts at t=50 (debounce).
for (let i = 1; i <= 6; i += 1) s.accept(input(i, 0));
snap("accept-1..6");
clock.t = 50;
const a = s.poll();
events.push({ at: 50, event: "job-start", job: a });
clock.t = 60;
s.accept(input(7, 60));
s.accept(input(8, 60));
snap("accept-7,8-in-flight");
events.push({ at: 60, event: "poll-while-in-flight", result: s.poll() });
clock.t = 150; // job A deadline = 50+100
const dead = s.timeout();
events.push({ at: 150, event: "timeout", deadToken: dead });
const b = s.poll();
events.push({ at: 150, event: "job-start-requeued", job: b });
if (b) {
  events.push({ at: 150, event: "resolve", input: b.token, result: s.resolve(b.token) });
}
if (a) {
  events.push({
    at: 150,
    event: "late-resolve-old-token",
    input: a.token,
    result: s.resolve(a.token),
  });
}
clock.t = 300;
snap("final");

const out =
  process.argv[2] ??
  ".omo/evidence/yuragoo-development/2026-09-20T14-23-20Z-7a9c693e/task-9-timeline.json";
writeFileSync(
  out,
  `${JSON.stringify({ generatedBy: "gen-task9-timeline.ts", events }, null, 2)}\n`,
);
console.log(`wrote ${events.length} events -> ${out}`);
