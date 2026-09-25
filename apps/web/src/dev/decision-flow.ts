// DecisionLab flow logic: the fixed four-choice demo state, staged-reaction
// attraction samples and the staging timeline constants. The evaluate seam
// (mock + live gateway) lives in decision-providers.ts; the async staging
// orchestration lives in decision-staging.ts.
import { type AcceptedMessage, buildActiveContext } from "@yuragoo/ai";
import { type AttractionSample, CANONICAL_SLOT_ANGLES } from "@yuragoo/creature";
import {
  type ChoiceId,
  type DecisionDistribution,
  type DecisionState,
  parseChoiceId,
  parseDecisionRevision,
} from "@yuragoo/protocol";
import type { LabEvaluation } from "./decision-providers";

export const LAB_SCENARIO = "昼食時。目の前に四つの食べ物がある。";
export const LAB_PERSONA = "甘党の生きもの";

// Staging timeline. The anticipation lean is held at least MIN_ANTICIPATION_MS
// even when the provider answers instantly; a top-2 margin below
// CONFLICT_MARGIN earns a visible 葛藤 dwell of CONFLICT_DWELL_MS.
export const MIN_ANTICIPATION_MS = 700;
export const CONFLICT_MARGIN = 0.15;
export const CONFLICT_DWELL_MS = 1500;
// During 葛藤, this share of the total weight is pushed onto the two torn
// directions evenly so the split pose reads at a glance.
const CONFLICT_BLEND = 0.6;

export interface LabChoice {
  readonly id: ChoiceId;
  readonly symbol: string;
  readonly label: string;
}
export const LAB_CHOICES: readonly LabChoice[] = [
  { id: parseChoiceId("a"), symbol: "○", label: "季節限定の濃厚プリン" },
  { id: parseChoiceId("b"), symbol: "◇", label: "素朴な塩むすび" },
  { id: parseChoiceId("c"), symbol: "△", label: "なぞの紫色のゼリー" },
  { id: parseChoiceId("d"), symbol: "□", label: "何も食べずに我慢する" },
];
export const DEFAULT_CHOICE: ChoiceId = LAB_CHOICES[0]?.id ?? parseChoiceId("a");

const ANGLES = CANONICAL_SLOT_ANGLES[4] ?? [];
// Shared by the local match (local/session.ts): the bounded-context budget
// every evaluation builds its activeContext under.
export const CONTEXT_CONFIG = {
  recentCount: 6,
  highImpactCount: 2,
  maxItems: 8,
  maxBytes: 2000,
} as const;

const angleAt = (index: number): number => ANGLES[index] ?? 0;
const choiceIndex = (id: ChoiceId): number => LAB_CHOICES.findIndex((c) => c.id === id);
const probabilityOf = (distribution: readonly DecisionDistribution[], id: ChoiceId): number =>
  distribution.find((d) => d.choiceId === id)?.probability ?? 0;

// Even resting weights before any submission.
export const restSamples = (): readonly AttractionSample[] =>
  LAB_CHOICES.map((_, i) => ({ angleRad: angleAt(i), weight: 0.25 }));

// The "ピクッ→そっちを見る" cue: a clear synchronous lean (advocated 0.5, the
// rest split 0.5 evenly) held until the staged reaction commits.
export const anticipationSamples = (advocated: ChoiceId): readonly AttractionSample[] => {
  const focus = choiceIndex(advocated);
  const share = 0.5 / (LAB_CHOICES.length - 1);
  return LAB_CHOICES.map((_, i) => ({
    angleRad: angleAt(i),
    weight: i === focus ? 0.5 : share,
  }));
};

export const distributionSamples = (
  distribution: readonly DecisionDistribution[],
): readonly AttractionSample[] =>
  LAB_CHOICES.map((choice, i) => ({
    angleRad: angleAt(i),
    weight: probabilityOf(distribution, choice.id),
  }));

// Top-2 probability margin — small means the creature is torn between them.
export const topTwoMargin = (distribution: readonly DecisionDistribution[]): number => {
  let best = 0;
  let second = 0;
  for (const d of distribution) {
    if (d.probability > best) {
      second = best;
      best = d.probability;
    } else if (d.probability > second) {
      second = d.probability;
    }
  }
  return best - second;
};

// The 葛藤 pose: keep the distribution's shape but push CONFLICT_BLEND of the
// weight onto the two torn directions evenly — a visible two-lobe split.
export const conflictSamples = (
  distribution: readonly DecisionDistribution[],
): readonly AttractionSample[] => {
  const ranked = LAB_CHOICES.map((choice, i) => ({
    i,
    p: probabilityOf(distribution, choice.id),
  })).sort((x, y) => y.p - x.p);
  const torn = new Set([ranked[0]?.i ?? -1, ranked[1]?.i ?? -1]);
  const boost = CONFLICT_BLEND / 2;
  return LAB_CHOICES.map((choice, i) => ({
    angleRad: angleAt(i),
    weight:
      (1 - CONFLICT_BLEND) * probabilityOf(distribution, choice.id) + (torn.has(i) ? boost : 0),
  }));
};

export const acceptMessage = (
  inputSeq: number,
  text: string,
  choiceId: ChoiceId,
): AcceptedMessage => ({
  inputSeq,
  messageId: `m${inputSeq}`,
  playerId: "lab-user",
  choiceId,
  text,
  acceptedAtMs: Date.now(),
  impact: 0.5,
  persistent: false,
});

export const buildNextState = (
  revision: number,
  messages: readonly AcceptedMessage[],
  advocated: ChoiceId,
  forMock: boolean,
  scenarioKey?: string,
): { state: DecisionState; contextSize: number } => {
  const context = buildActiveContext(messages, CONTEXT_CONFIG);
  const state: DecisionState = {
    revision: parseDecisionRevision(revision),
    scenario: LAB_SCENARIO,
    persona: LAB_PERSONA,
    activeContext: context.items.map((item) => item.text),
    choices: LAB_CHOICES.map(({ id, label }) => ({ id, label })),
    ...(forMock ? { mockScenarioKey: scenarioKey ?? `favor-${advocated}` } : {}),
  };
  return { state, contextSize: context.items.length };
};

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const formatResultLine = (evaluation: LabEvaluation, latencyMs: number): string => {
  const selected = LAB_CHOICES.find((c) => c.id === evaluation.result.selectedChoiceId);
  const arrow = selected
    ? `→${selected.symbol}${selected.id.toUpperCase()}`
    : `→${evaluation.result.selectedChoiceId}`;
  const attempts =
    evaluation.attempts !== undefined ? ` · 試行${evaluation.attempts.sessionAttempts}` : "";
  return `${evaluation.result.model} · ${evaluation.source} · ${Math.round(latencyMs)}ms · ${arrow}${attempts}`;
};

export type FlowStatus = "idle" | "pending" | "conflicted" | "resolved" | "failed";

// data-status stays machine-readable; this table is the human-readable face.
export const STATUS_LABELS: Readonly<Record<FlowStatus, string>> = {
  idle: "ひらめき待ち",
  pending: "きいてる",
  conflicted: "まよってる",
  resolved: "きまった",
  failed: "しっぱい",
};

export interface FlowSnap {
  status: FlowStatus;
  anticipationMs: number;
  /** ms since submit when the anticipation lean was applied (~0). */
  anticipationAt: number;
  /** ms since submit when the 葛藤 dwell began; 0 = never conflicted. */
  conflictedAt: number;
  /** ms since submit when the result committed; 0 = not yet. */
  resolvedAt: number;
  revision: number;
  contextSize: number;
  lastModel: string;
  lastSource: string;
  errorKind: string | null;
}

export const INITIAL_SNAP: FlowSnap = {
  status: "idle",
  anticipationMs: 0,
  anticipationAt: 0,
  conflictedAt: 0,
  resolvedAt: 0,
  revision: 0,
  contextSize: 0,
  lastModel: "",
  lastSource: "",
  errorKind: null,
};
