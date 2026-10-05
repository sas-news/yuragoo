// Pure helpers for the local match host loop — no React, no clocks, no I/O.
// Everything here maps between game-core state (posts, roster slots, cutoff)
// and the AI-facing view (AcceptedMessage context, distributions, claims),
// plus the ?players/mode/seed/eval URL knobs e2e drives. Unit-testable.
import { type AcceptedMessage, buildActiveContext } from "@yuragoo/ai";
import {
  ADHESION_SECONDS_MAX,
  type GameMode,
  type GameSettings,
  type GameState,
  LIVE_SECONDS_MAX,
  type Player,
  type PostedInput,
  ROSTER_SIZE_MAX,
  ROUNDS_MAX,
  type SettleClaim,
  SETTLE_SECONDS_MAX,
  TURN_SECONDS_MAX,
} from "@yuragoo/game-core";
import {
  type DecisionDistribution,
  type DecisionState,
  parseChoiceId,
  parseDecisionRevision,
  type RoomLanguage,
  ROOM_LANGUAGE_DEFAULT,
} from "@yuragoo/protocol";
import { CONTEXT_CONFIG } from "../dev/decision-flow";
import { choicesFor, dominanceOf, dominantSlot, localPersona, localScenario } from "./scenario";

export interface LocalSetup {
  readonly players: number;
  readonly mode: GameMode;
  readonly seed: number;
}

// URL knobs: ?players=&mode=&seed= pick the setup; ?eval=live switches the
// provider; ?evalDelay=/​?failEval=/​?turn=/​?live=/​?dwell=/​?settle=/​?rounds=
// are timing/rule overrides kept for deterministic e2e. ?grace= sets the
// consecutive-dominance streak needed for an early end (posts, not seconds).
export interface LocalParams extends LocalSetup {
  // The device's UI language doubles as the local room language — the
  // scenario, choices and eval instructions all ride it.
  readonly language: RoomLanguage;
  readonly evalKind: "mock" | "live";
  readonly evalDelayMs: number;
  readonly failEval: boolean;
  readonly grace: number;
  readonly turnSeconds?: number;
  readonly liveSeconds?: number;
  readonly adhesionSeconds?: number;
  readonly settleSeconds?: number;
  readonly rounds?: number;
}

// Generous turn slots: on one shared screen nobody should race a wall clock
// (same trick as the dev harness), so a deadline pass never hijacks a match.
const LOCAL_TURN_SECONDS = 300;

// Early-decision grace window in POSTS (15b): this many straight dominant
// evaluations of one slot end the match — default 3 = dominance + 2 grace
// posts of 猶予 before the dwell can close gameplay.
export const DWELL_GRACE_DEFAULT = 3;
export const DWELL_GRACE_MAX = 12;

const intParam = (params: URLSearchParams, name: string): number | undefined => {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

const ranged = (
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | undefined => {
  const value = intParam(params, name);
  return value === undefined ? undefined : Math.min(Math.max(value, min), max);
};

export const parseLocalParams = (
  search: string,
  language: RoomLanguage = ROOM_LANGUAGE_DEFAULT,
): LocalParams => {
  const params = new URLSearchParams(search);
  const turnSeconds = ranged(params, "turn", 1, TURN_SECONDS_MAX);
  const liveSeconds = ranged(params, "live", 1, LIVE_SECONDS_MAX);
  const adhesionSeconds = ranged(params, "dwell", 1, ADHESION_SECONDS_MAX);
  const settleSeconds = ranged(params, "settle", 1, SETTLE_SECONDS_MAX);
  const rounds = ranged(params, "rounds", 1, ROUNDS_MAX);
  return {
    language,
    players: ranged(params, "players", 2, ROSTER_SIZE_MAX) ?? 4,
    mode: params.get("mode") === "live" ? "live" : "turn",
    seed: intParam(params, "seed") ?? 7,
    evalKind: params.get("eval") === "live" ? "live" : "mock",
    evalDelayMs: ranged(params, "evalDelay", 0, 30_000) ?? 0,
    failEval: params.get("failEval") === "1",
    grace: ranged(params, "grace", 1, DWELL_GRACE_MAX) ?? DWELL_GRACE_DEFAULT,
    ...(turnSeconds !== undefined ? { turnSeconds } : {}),
    ...(liveSeconds !== undefined ? { liveSeconds } : {}),
    ...(adhesionSeconds !== undefined ? { adhesionSeconds } : {}),
    ...(settleSeconds !== undefined ? { settleSeconds } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
  };
};

// Local /play keeps its free-range timing knobs and its client-side
// dwell streak: devMode relaxes the contract's discrete menus (sandbox)
// and both optional switches are explicitly ON so the local early-end
// behaviour is unchanged by the new server defaults (Task 26).
export const buildLocalSettings = (setup: LocalSetup, params: LocalParams): GameSettings => ({
  mode: setup.mode,
  language: params.language,
  seed: setup.seed,
  rosterSize: setup.players,
  devMode: true,
  earlyDecision: true,
  hostDecision: true,
  turnSeconds: params.turnSeconds ?? LOCAL_TURN_SECONDS,
  ...(params.liveSeconds !== undefined ? { liveSeconds: params.liveSeconds } : {}),
  ...(params.adhesionSeconds !== undefined ? { adhesionSeconds: params.adhesionSeconds } : {}),
  ...(params.settleSeconds !== undefined ? { settleSeconds: params.settleSeconds } : {}),
  ...(params.rounds !== undefined ? { rounds: params.rounds } : {}),
});

// Posts -> the shared AcceptedMessage contract for buildActiveContext. A
// post's choiceId is the poster's OWN slot choice — each player advocates
// their attractor (that's what "favor-<id>" fixtures key off too).
export const toAcceptedMessages = (
  posts: readonly PostedInput[],
  roster: readonly Player[],
  lang: RoomLanguage = "ja",
): AcceptedMessage[] => {
  const choices = choicesFor(roster.length, lang);
  const fallback = choices[0]?.id ?? parseChoiceId("a");
  return posts.map((post) => {
    const slot = roster.find((p) => p.id === post.playerId)?.slot ?? 0;
    return {
      inputSeq: post.seq,
      messageId: post.postId,
      playerId: post.playerId,
      choiceId: choices[slot]?.id ?? fallback,
      text: post.text,
      acceptedAtMs: post.postedAtMs,
      impact: 0.5,
      persistent: false,
    };
  });
};

// Consecutive-dominance dwell (Task 15b): the early decision counts straight
// dominant EVALUATIONS, not seconds — `grace` (default 3 = dominance + 2
// grace posts) of them on the same slot fire the early end. dwellStep is the
// pure streak transition: a clear winner on a different slot restarts at 1,
// the same slot accrues, an unclear/absent dist resets. `adhere` re-reports
// the slot on EVERY dominant step — an accepted post clears the reducer's
// adhesion, so skipping the re-report was the "ring never returns" bug.
export interface DwellState {
  readonly slot: number | null;
  readonly streak: number;
}

export interface DwellStep extends DwellState {
  readonly adhere: number | null;
  readonly fire: boolean;
}

export const DWELL_RESET: DwellStep = { slot: null, streak: 0, adhere: null, fire: false };

export const dwellStep = (
  prev: DwellState,
  dist: readonly DecisionDistribution[] | null,
  grace: number = DWELL_GRACE_DEFAULT,
): DwellStep => {
  const slot = dist === null ? null : dominanceOf(dist);
  if (slot === null) return DWELL_RESET;
  const streak = slot === prev.slot ? prev.streak + 1 : 1;
  return { slot, streak, adhere: slot, fire: streak >= grace };
};

// Newest evaluated post's distribution, restricted to seq <= cutoffSeq when
// given (settle looks only inside the cutoff; live pull takes all posts).
export const latestEvaluatedDist = (
  posts: readonly PostedInput[],
  dists: ReadonlyMap<string, readonly DecisionDistribution[]>,
  cutoffSeq?: number,
): readonly DecisionDistribution[] | null => {
  const cutoff = cutoffSeq ?? Number.MAX_SAFE_INTEGER;
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const post = posts[i];
    if (post === undefined || post.seq > cutoff || post.status !== "evaluated") continue;
    const dist = dists.get(post.postId);
    if (dist !== undefined) return dist;
  }
  return null;
};

// The host's settle claim: winner = dominant slot of the newest evaluated
// distribution inside the cutoff; no landed evaluation -> noContest/budget
// (pending posts are forced to noContest/pending by resolveOutcome anyway).
export const claimFor = (
  state: GameState,
  dists: ReadonlyMap<string, readonly DecisionDistribution[]>,
): SettleClaim => {
  const dist = latestEvaluatedDist(state.posts, dists, state.settleCutoffSeq ?? state.seq);
  if (dist === null) return { kind: "noContest", reason: "budget" };
  return { kind: "winner", slot: dominantSlot(dist) };
};

// The DecisionState handed to the provider for one post: scenario/persona,
// bounded context of accepted posts up to this post's seq, the seat-count
// choices, and the mock key pinning the fixture to the poster's slot.
export const buildPostDecisionState = (
  state: GameState,
  post: PostedInput,
  lang: RoomLanguage = "ja",
): DecisionState => {
  const choices = choicesFor(state.roster.length, lang);
  const prior = state.posts.filter((p) => p.seq <= post.seq);
  const context = buildActiveContext(toAcceptedMessages(prior, state.roster, lang), CONTEXT_CONFIG);
  const slot = state.roster.find((p) => p.id === post.playerId)?.slot ?? 0;
  const choice = choices[slot] ?? choices[0];
  return {
    revision: parseDecisionRevision(post.seq),
    scenario: localScenario(lang),
    persona: localPersona(lang),
    activeContext: context.items.map((item) => item.text),
    choices: choices.map(({ id, label }) => ({ id, label })),
    language: lang,
    ...(choice !== undefined ? { mockScenarioKey: `favor-${choice.id}` } : {}),
  };
};
