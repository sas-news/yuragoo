// Task 9: single-flight scheduler, duplicate attenuation, bounded active
// context and impact metrics — all pure, driven by a fake clock.
import { expect, test } from "bun:test";
import {
  buildActiveContext,
  ContextContractError,
  distributionImpact,
  duplicateAttenuation,
  EvaluationScheduler,
  groupImpact,
  normalizeForDuplicate,
  singleImpact,
} from "@yuragoo/ai";
import { cfg, dist, FakeClock, input, invalidCfgs, msg, mustJob } from "./scheduling-helpers";

test("happy: continuous arrivals wait for maxWait, not debounce", () => {
  // Given accepts every 100ms with debounce 250 and maxWait 1000
  const clock = new FakeClock();
  const s = new EvaluationScheduler(cfg({ debounceMs: 250, maxWaitMs: 1000 }), clock);
  for (let t = 0; t <= 900; t += 100) {
    clock.t = t;
    s.accept(input(t / 100 + 1, { acceptedAtMs: t }));
    // Then no job starts early even though debounce never quiets
    expect(s.poll()).toBeNull();
  }
  for (const t of [950, 999]) {
    clock.t = t;
    expect(s.poll()).toBeNull();
  }
  // And at exactly 1000 the job starts with every accepted input
  clock.t = 1000;
  s.accept(input(11, { acceptedAtMs: 1000 }));
  const job = mustJob(s.poll());
  expect(job.cutoffSeq).toBe(11);
  expect(job.inputs.length).toBe(11);
});

test("happy: a burst runs single-flight and resolves apply prefixes", () => {
  // Given six accepted inputs, When a job starts and newer inputs arrive
  const s = new EvaluationScheduler(cfg(), new FakeClock());
  for (let i = 1; i <= 6; i += 1) s.accept(input(i));
  const a = mustJob(s.poll());
  expect(a.cutoffSeq).toBe(6);
  s.accept(input(7));
  s.accept(input(8));
  // Then no second job runs while A is in flight
  expect(s.poll()).toBeNull();
  // And resolving A applies its prefix even though newer seqs exist
  expect(s.resolve(a.token)).toEqual({ applied: true, cutoffSeq: 6 });
  const b = mustJob(s.poll());
  expect(b.inputs.map((i) => i.inputSeq)).toEqual([7, 8]);
  expect(b.cutoffSeq).toBe(8);
});

test("happy: a timed-out job requeues ahead of newer pending inputs", () => {
  // Given job A in flight, When it times out after B was accepted
  const clock = new FakeClock();
  const s = new EvaluationScheduler(cfg({ debounceMs: 50, maxWaitMs: 100 }), clock);
  s.accept(input(1, { acceptedAtMs: 0 }));
  clock.t = 50;
  const a = mustJob(s.poll());
  clock.t = 60;
  s.accept(input(2, { acceptedAtMs: 60 }));
  clock.t = 150;
  // Then timeout requeues A ahead of B and poll restarts immediately
  expect(s.timeout()?.jobId).toBe(a.token.jobId);
  const b = mustJob(s.poll());
  expect(b.inputs.map((i) => i.inputSeq)).toEqual([1, 2]);
  expect(s.resolve(b.token)).toEqual({ applied: true, cutoffSeq: 2 });
  // And a late resolve for the dead token A is ignored
  expect(s.resolve(a.token)).toEqual({ applied: false, cutoffSeq: null });
});

test("failure: reset and close invalidate old tokens and block accepts", () => {
  const s = new EvaluationScheduler(cfg(), new FakeClock());
  s.accept(input(1));
  const a = mustJob(s.poll());
  // When reset, Then the epoch advances and the old token is dead
  s.reset();
  expect(s.resolve(a.token)).toEqual({ applied: false, cutoffSeq: null });
  expect(s.poll()).toBeNull();
  s.accept(input(1));
  expect(s.snapshot().epoch).toBe(1);
  const b = mustJob(s.poll());
  s.close();
  expect(s.snapshot().state).toBe("closed");
  expect(s.resolve(b.token)).toEqual({ applied: false, cutoffSeq: null });
  expect(() => s.accept(input(2))).toThrow(ContextContractError);
  expect(s.poll()).toBeNull();
  // An idle scheduler never produces work
  const idle = new EvaluationScheduler(cfg(), new FakeClock());
  expect([idle.poll(), idle.poll(), idle.poll()]).toEqual([null, null, null]);
});

test("failure: count and byte caps reject before mutation", () => {
  const s = new EvaluationScheduler(cfg({ maxPending: 2, maxPendingBytes: 10 }), new FakeClock());
  s.accept(input(1, { byteLength: 6 }));
  expect(() => s.accept(input(2, { byteLength: 5 }))).toThrowError(/bytes/);
  s.accept(input(2, { byteLength: 4 }));
  expect(() => s.accept(input(3))).toThrowError(/count/);
  const snap = s.snapshot();
  expect(snap.pendingCount).toBe(2);
  expect(snap.pendingBytes).toBe(10);
  expect(snap.inFlight).toBeNull();
});

test("failure: backward clocks, bad seqs, bad config and bad inputs reject", () => {
  const clock = new FakeClock();
  const s = new EvaluationScheduler(cfg(), clock);
  s.accept(input(2));
  for (const seq of [2, 1, 0]) {
    expect(() => s.accept(input(seq))).toThrow(ContextContractError);
  }
  expect(() => s.accept(input(3, { byteLength: -1 }))).toThrow(ContextContractError);
  clock.t = 5;
  expect(() => s.accept(input(3, { acceptedAtMs: 9 }))).toThrow(ContextContractError);
  clock.t = -1;
  expect(() => s.poll()).toThrow(RangeError);
  expect(s.snapshot().pendingCount).toBe(1);
  for (const over of invalidCfgs) {
    expect(() => new EvaluationScheduler(cfg(over), new FakeClock())).toThrow(RangeError);
  }
});

test("happy: duplicate aliases attenuate while distinct text stays full", () => {
  // Given equivalent sale phrases in different scripts
  expect(normalizeForDuplicate("５０％ＯＦＦ")).toBe("半額");
  expect(normalizeForDuplicate("50% off")).toBe("半額");
  expect(normalizeForDuplicate("半額")).toBe("半額");
  // Then a repeated phrase is attenuated to the floor and bounds stay finite
  const dup = duplicateAttenuation("半額", ["50%off"]);
  expect(dup.maxSimilarity).toBe(1);
  expect(dup.factor).toBeCloseTo(0.2, 6);
  const fresh = duplicateAttenuation("今日は雨です", ["明日は晴れだ"]);
  expect(fresh.factor).toBe(1);
  const near = duplicateAttenuation("今日は雨ですね", ["今日は雨です"]);
  expect(near.factor).toBeGreaterThan(0.2);
  expect(near.factor).toBeLessThan(1);
});

test("happy: active context mixes categories under item and byte budgets", () => {
  const messages = [
    msg(1, { text: "old pin", persistent: true, impact: 0.1 }),
    msg(2, { text: "dup A" }),
    msg(3, { text: "dup A" }),
    msg(4, { text: "imp", impact: 0.9 }),
    msg(5, { text: "r1" }),
    msg(6, { text: "r2" }),
  ];
  const ctx = buildActiveContext(messages, {
    recentCount: 2,
    highImpactCount: 1,
    maxItems: 10,
    maxBytes: 10_000,
  });
  expect(ctx.items.map((i) => i.inputSeq)).toEqual([1, 4, 5, 6]);
  expect(ctx.items[0]?.reason).toBe("persistent");
  expect(ctx.items.find((i) => i.inputSeq === 4)?.reason).toBe("high-impact");
  // Duplicate spam is attenuated inside the selection
  const spam = buildActiveContext(
    [msg(1, { text: "dup" }), msg(2, { text: "dup" }), msg(3, { text: "dup" })],
    { recentCount: 3, highImpactCount: 0, maxItems: 10, maxBytes: 10_000 },
  );
  expect(spam.items[2]?.duplicateFactor).toBeCloseTo(0.2, 6);
  expect(spam.items[2]?.effectiveImpact).toBeCloseTo(0.1, 6);
  // UTF-8 bytes are bounded and an oversized item yields to a smaller one
  const tight = buildActiveContext(
    [msg(1, { text: "12345" }), msg(2, { text: "1234567890" }), msg(3, { text: "1" })],
    { recentCount: 3, highImpactCount: 0, maxItems: 10, maxBytes: 6 },
  );
  expect(tight.items.map((i) => i.inputSeq)).toEqual([1, 3]);
  expect(tight.totalBytes).toBe(6);
  const capped = buildActiveContext(messages, {
    recentCount: 6,
    highImpactCount: 2,
    maxItems: 2,
    maxBytes: 10_000,
  });
  expect(capped.items.length).toBe(2);
});

test("failure: context rejects bad messages, config and oversize lists", () => {
  const conf = { recentCount: 1, highImpactCount: 1, maxItems: 4, maxBytes: 100 };
  expect(() => buildActiveContext([msg(1, { inputSeq: 0 })], conf)).toThrow(ContextContractError);
  expect(() => buildActiveContext([msg(1), msg(1, { messageId: "m2" })], conf)).toThrow(
    ContextContractError,
  );
  expect(() => buildActiveContext([msg(1, { text: "  " })], conf)).toThrow(ContextContractError);
  expect(() => buildActiveContext([msg(1, { impact: 1.5 })], conf)).toThrow(ContextContractError);
  expect(() => buildActiveContext([msg(1)], { ...conf, maxBytes: 0 })).toThrow(
    ContextContractError,
  );
  expect(() => buildActiveContext([], { ...conf, recentCount: -1 })).toThrow(ContextContractError);
  const huge = Array.from({ length: 10_001 }, (_, i) => msg(i + 1));
  expect(() => buildActiveContext(huge, conf)).toThrow(ContextContractError);
});

test("happy: impact is order-independent and single honors attenuation", () => {
  const before = dist([
    ["a", 0.9],
    ["b", 0.1],
  ]);
  const after = dist([
    ["b", 0.6],
    ["a", 0.4],
  ]);
  expect(distributionImpact(before, after)).toBeCloseTo(0.5, 6);
  const single = singleImpact(3, before, after, 0.4);
  expect(single.kind).toBe("single");
  expect(single.score).toBeCloseTo(0.2, 6);
  const group = groupImpact(3, 5, before, after);
  expect(group).toEqual({ kind: "group", fromSeq: 3, toSeq: 5, score: 0.5 });
});

test("failure: invalid distributions and impact ranges reject", () => {
  const good = dist([
    ["a", 0.5],
    ["b", 0.5],
  ]);
  const diffIds = dist([
    ["a", 0.5],
    ["c", 0.5],
  ]);
  const badSum = dist([
    ["a", 0.4],
    ["b", 0.4],
  ]);
  const badRange = dist([
    ["a", 1.5],
    ["b", -0.5],
  ]);
  const dupIds = dist([
    ["a", 0.5],
    ["a", 0.5],
  ]);
  expect(() => distributionImpact(good, diffIds)).toThrow(ContextContractError);
  expect(() => distributionImpact(good, badSum)).toThrow(ContextContractError);
  expect(() => distributionImpact(good, badRange)).toThrow(ContextContractError);
  expect(() => distributionImpact(dupIds, good)).toThrow(ContextContractError);
  expect(() => singleImpact(0, good, good)).toThrow(ContextContractError);
  expect(() => singleImpact(1, good, good, 1.5)).toThrow(ContextContractError);
  expect(() => groupImpact(5, 3, good, good)).toThrow(ContextContractError);
});
