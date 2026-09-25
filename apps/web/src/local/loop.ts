// The local-match host loop (Task 15) — the imperative half of /play, kept
// React-free. It owns the authoritative GameState, runs the reducer's
// commands (evaluate, deadline timers, event log), drives dwell + settle,
// and resets cleanly on rematch: epoch bumps drop in-flight provider results.
import {
  type GameAction,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerId,
  reduce,
} from "@yuragoo/game-core";
import type { DecisionDistribution } from "@yuragoo/protocol";
import { createDwell } from "./dwell";
import { LOCAL_PLAYER_IDS } from "./scenario";
import type { LocalEvaluate } from "./providers";
import {
  buildLocalSettings,
  buildPostDecisionState,
  claimFor,
  type LocalParams,
  type LocalSetup,
} from "./session";

export type DockStatus = "idle" | "pending";

export interface LocalLoopDeps {
  readonly params: LocalParams;
  readonly makeEvaluate: (rosterSize: number) => LocalEvaluate; // per match
  readonly onGame: (state: GameState | null) => void;
  readonly onStatus: (status: DockStatus) => void;
}

export interface LocalLoop {
  dispatch(action: GameAction): void;
  submit(text: string, playerId: PlayerId): void;
  boot(setup: LocalSetup): void;
  rematch(setup: LocalSetup): void;
  dispose(): void;
  state(): GameState | null;
  epoch(): number;
  events(): readonly GameEvent[];
  dists(): ReadonlyMap<string, readonly DecisionDistribution[]>;
}

// Grace after gameplay closes: the last evaluations get this long to land
// before the host settles with whatever is inside the cutoff (a pending post
// forces noContest; the armed settle deadline is the timeout backstop).
const SETTLE_GRACE_MS = 2000;

export const createLocalLoop = (deps: LocalLoopDeps): LocalLoop => {
  let state: GameState | null = null;
  let epoch = 0;
  let evaluator: LocalEvaluate | null = null;
  const events: GameEvent[] = [];
  const dists = new Map<string, readonly DecisionDistribution[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };

  // schedule: a setTimeout that unregisters itself when it fires — every
  // armed timer lives in `timers` so reset() drops the whole epoch's work.
  const schedule = (fn: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        fn();
      },
      Math.max(0, delayMs),
    );
    timers.add(timer);
    return timer;
  };

  const runEval = (postId: string): void => {
    const current = state;
    const evaluate = evaluator;
    const post = current?.posts.find((p) => p.postId === postId);
    if (current === null || post === undefined || evaluate === null) return;
    const myEpoch = epoch;
    void evaluate(buildPostDecisionState(current, post)).then(
      (evaluation) => {
        if (epoch !== myEpoch) return; // rematch mid-flight: drop the answer
        dists.set(postId, evaluation.result.distribution);
        deps.onStatus("idle");
        try {
          dispatch({ type: "evaluated", postId });
        } catch {
          // The post vanished with its match — nothing left to mark.
        }
      },
      // Failure leaves the post pending; settle forces noContest later.
      () => epoch === myEpoch && deps.onStatus("idle"),
    );
  };

  const armDeadline = (atMs: number, tag: "turn" | "match" | "settle"): void => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        const nowMs = Math.max(Date.now(), atMs);
        try {
          dispatch(
            tag === "settle"
              ? { type: "settle-deadline", nowMs }
              : { type: "deadline-reached", nowMs },
          );
        } catch {
          // Stale deadline (turn already advanced / phase moved on) — safe.
        }
      },
      Math.max(0, atMs - Date.now()),
    );
    timers.add(timer);
  };

  const runCommand = (command: GameCommand): void => {
    if (command.type === "publish") events.push(command.event);
    else if (command.type === "evaluate") runEval(command.postId);
    else if (command.type === "set-deadline") armDeadline(command.atMs, command.tag);
    // finish / close-room: nothing else to run locally.
  };

  // Settle: once "complete", settle as soon as nothing inside the cutoff is
  // pending; otherwise arm the short grace timer (the settle-deadline command
  // armed by the reducer stays the hard backstop -> noContest/timeout).
  const maybeSettle = (): void => {
    const s = state;
    if (s === null || s.phase !== "complete") return;
    const cutoff = s.settleCutoffSeq ?? s.seq;
    const pending = s.posts.some((p) => p.status === "pending" && p.seq <= cutoff);
    const trySettle = (): void => {
      const cur = state;
      if (cur === null || cur.phase !== "complete") return;
      try {
        dispatch({ type: "settle", nowMs: Date.now(), claim: claimFor(cur, dists) });
      } catch {
        // A racing trigger already fixed the outcome.
      }
    };
    if (!pending) {
      trySettle();
      return;
    }
    if (settleTimer !== null) return;
    const timer = setTimeout(() => {
      settleTimer = null;
      timers.delete(timer);
      trySettle();
    }, SETTLE_GRACE_MS);
    settleTimer = timer;
    timers.add(timer);
  };

  const dispatch = (action: GameAction): void => {
    const transition = reduce(state, action);
    state = transition.state;
    deps.onGame(transition.state);
    for (const command of transition.commands) runCommand(command);
    // The dwell streak steps only on fresh evaluations; an accepted post
    // interrupts the armed retry (the reducer cleared the adhesion) while
    // the streak itself rides over the grace posts.
    if (action.type === "evaluated") dwell.step();
    else if (action.type === "post") dwell.interrupted();
    maybeSettle();
  };

  // Early decision as a consecutive-dominance streak (dwell.ts): grace
  // straight dominant evals of one slot fire dwell-complete — the creature
  // gets a few more posts before the match can end, never an instant ring.
  const dwell = createDwell({
    grace: deps.params.grace,
    getState: () => state,
    dists,
    dispatch,
    schedule,
    cancel: clearTimer,
  });

  const boot = (setup: LocalSetup): void => {
    evaluator = deps.makeEvaluate(setup.players);
    const nowMs = Date.now();
    dispatch({
      type: "create",
      settings: buildLocalSettings(setup, deps.params),
      playerIds: LOCAL_PLAYER_IDS.slice(0, setup.players),
      nowMs,
    });
    dispatch({ type: "start", nowMs });
  };

  const reset = (): void => {
    epoch += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    settleTimer = null;
    dwell.reset();
    dists.clear();
    events.length = 0;
    state = null;
    deps.onStatus("idle");
  };

  return {
    dispatch,
    submit: (text, playerId) => {
      if (state === null || state.phase !== "playing") return;
      deps.onStatus("pending");
      try {
        dispatch({ type: "post", playerId, text, nowMs: Date.now() });
      } catch {
        deps.onStatus("idle"); // rejected post emits nothing: release the dock
      }
    },
    boot,
    rematch: (setup) => {
      reset();
      boot(setup);
    },
    dispose: reset, // epoch bump also invalidates in-flight evals
    state: () => state,
    epoch: () => epoch,
    events: () => [...events],
    dists: () => new Map(dists),
  };
};
