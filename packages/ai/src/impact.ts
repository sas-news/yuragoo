// Impact metrics: total-variation distance between two decision
// distributions, per-input records and grouped-window records.
import { choiceIdSchema, type DecisionDistribution } from "@yuragoo/protocol";
import { ContextContractError } from "./context";

export type ImpactRecord =
  | { readonly kind: "single"; readonly inputSeq: number; readonly score: number }
  | {
      readonly kind: "group";
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly score: number;
    };

const checkDistribution = (distribution: readonly DecisionDistribution[]): Map<string, number> => {
  const map = new Map<string, number>();
  let sum = 0;
  for (const entry of distribution) {
    if (!choiceIdSchema.safeParse(entry.choiceId).success) {
      throw new ContextContractError("distribution contains an invalid choiceId");
    }
    const id = String(entry.choiceId);
    if (map.has(id)) {
      throw new ContextContractError("distribution contains duplicate choice ids");
    }
    if (!Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) {
      throw new ContextContractError("probabilities must be finite inside [0, 1]");
    }
    map.set(id, entry.probability);
    sum += entry.probability;
  }
  if (Math.abs(sum - 1) > 1e-6) {
    throw new ContextContractError("distribution probabilities must sum to 1");
  }
  return map;
};

// Order-independent total variation: both sides must cover the same unique
// choice ids with legal probabilities summing to 1 within 1e-6.
export const distributionImpact = (
  before: readonly DecisionDistribution[],
  after: readonly DecisionDistribution[],
): number => {
  const b = checkDistribution(before);
  const a = checkDistribution(after);
  if (a.size !== b.size) {
    throw new ContextContractError("distributions must cover the same choice ids");
  }
  let distance = 0;
  for (const [id, p] of b) {
    const q = a.get(id);
    if (q === undefined) {
      throw new ContextContractError("distributions must cover the same choice ids");
    }
    distance += Math.abs(q - p);
  }
  return 0.5 * distance;
};

const checkSeq = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextContractError(`${name} must be a safe integer >= 1`);
  }
};

// A single input's impact: the distribution shift multiplied by its
// (validated) duplicate-attenuation factor.
export const singleImpact = (
  inputSeq: number,
  before: readonly DecisionDistribution[],
  after: readonly DecisionDistribution[],
  duplicateFactor = 1,
): ImpactRecord => {
  checkSeq(inputSeq, "inputSeq");
  if (!Number.isFinite(duplicateFactor) || duplicateFactor < 0 || duplicateFactor > 1) {
    throw new ContextContractError("duplicateFactor must be finite inside [0, 1]");
  }
  return {
    kind: "single",
    inputSeq,
    score: distributionImpact(before, after) * duplicateFactor,
  };
};

// A grouped window's impact: the full distribution shift — group records are
// never silently divided by the number of inputs they cover.
export const groupImpact = (
  fromSeq: number,
  toSeq: number,
  before: readonly DecisionDistribution[],
  after: readonly DecisionDistribution[],
): ImpactRecord => {
  checkSeq(fromSeq, "fromSeq");
  checkSeq(toSeq, "toSeq");
  if (fromSeq > toSeq) {
    throw new ContextContractError("fromSeq must not exceed toSeq");
  }
  return { kind: "group", fromSeq, toSeq, score: distributionImpact(before, after) };
};
