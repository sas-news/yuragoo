// Bounded Active Context construction for accepted player inputs: validates
// the shared message contract, attenuates near-duplicates and selects
// persistent/recent/high-impact items under item and UTF-8 byte budgets.
import { choiceIdSchema, type ChoiceId } from "@yuragoo/protocol";
import { duplicateAttenuation } from "./duplicates";

export class ContextContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextContractError";
  }
}

export interface AcceptedMessage {
  readonly inputSeq: number;
  readonly messageId: string;
  readonly playerId: string;
  readonly choiceId: ChoiceId;
  readonly text: string;
  readonly acceptedAtMs: number;
  readonly impact: number;
  readonly persistent: boolean;
}

export interface ActiveContextConfig {
  readonly recentCount: number;
  readonly highImpactCount: number;
  readonly maxItems: number;
  readonly maxBytes: number;
}

export interface ActiveContextItem {
  readonly messageId: string;
  readonly inputSeq: number;
  readonly text: string;
  readonly reason: "persistent" | "recent" | "high-impact";
  readonly effectiveImpact: number;
  readonly duplicateFactor: number;
}

export interface ActiveContext {
  readonly items: readonly ActiveContextItem[];
  readonly totalBytes: number;
}

const MAX_ACCEPTED_MESSAGES = 10_000;
const encoder = new TextEncoder();

const trimmedId = (value: string, name: string): void => {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 64
  ) {
    throw new ContextContractError(`${name} must be a trimmed 1..64 character string`);
  }
};

export const validateAcceptedMessage = (message: AcceptedMessage): void => {
  if (!Number.isSafeInteger(message.inputSeq) || message.inputSeq < 1) {
    throw new ContextContractError("inputSeq must be a safe integer >= 1");
  }
  trimmedId(message.messageId, "messageId");
  trimmedId(message.playerId, "playerId");
  if (!choiceIdSchema.safeParse(message.choiceId).success) {
    throw new ContextContractError("choiceId must be a valid choice id");
  }
  if (typeof message.text !== "string" || message.text.trim().length === 0) {
    throw new ContextContractError("text must be nonblank");
  }
  if (!Number.isFinite(message.acceptedAtMs) || message.acceptedAtMs < 0) {
    throw new ContextContractError("acceptedAtMs must be finite and >= 0");
  }
  if (!Number.isFinite(message.impact) || message.impact < 0 || message.impact > 1) {
    throw new ContextContractError("impact must be finite inside [0, 1]");
  }
  if (typeof message.persistent !== "boolean") {
    throw new ContextContractError("persistent must be a boolean");
  }
};

const checkConfig = (config: ActiveContextConfig): void => {
  if (!Number.isSafeInteger(config.recentCount) || config.recentCount < 0) {
    throw new ContextContractError("recentCount must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(config.highImpactCount) || config.highImpactCount < 0) {
    throw new ContextContractError("highImpactCount must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(config.maxItems) || config.maxItems <= 0) {
    throw new ContextContractError("maxItems must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) {
    throw new ContextContractError("maxBytes must be a positive safe integer");
  }
};

interface Scored {
  readonly message: AcceptedMessage;
  readonly bytes: number;
  readonly factor: number;
  readonly effectiveImpact: number;
}

// Persistent items first by seq (still byte-bounded), then the newest
// nonselected up to recentCount, then the highest effectiveImpact up to
// highImpactCount. An item that does not fit the remaining byte budget is
// skipped so smaller candidates can still enter; output is seq-ascending.
export const buildActiveContext = (
  messages: readonly AcceptedMessage[],
  config: ActiveContextConfig,
): ActiveContext => {
  checkConfig(config);
  if (messages.length > MAX_ACCEPTED_MESSAGES) {
    throw new ContextContractError("accepted message list exceeds 10000 entries");
  }
  const sorted = [...messages].sort((a, b) => a.inputSeq - b.inputSeq);
  const seenSeq = new Set<number>();
  const seenId = new Set<string>();
  const priorTexts: string[] = [];
  const scored: Scored[] = [];
  for (const message of sorted) {
    validateAcceptedMessage(message);
    if (seenSeq.has(message.inputSeq) || seenId.has(message.messageId)) {
      throw new ContextContractError("inputSeq and messageId must be unique");
    }
    seenSeq.add(message.inputSeq);
    seenId.add(message.messageId);
    const factor = duplicateAttenuation(message.text, priorTexts.slice(-12)).factor;
    priorTexts.push(message.text);
    scored.push({
      message,
      bytes: encoder.encode(message.text).length,
      factor,
      effectiveImpact: message.impact * factor,
    });
  }
  const picked = new Map<number, ActiveContextItem>();
  let usedBytes = 0;
  const tryAdd = (entry: Scored, reason: ActiveContextItem["reason"]): void => {
    const m = entry.message;
    if (picked.size >= config.maxItems || picked.has(m.inputSeq)) return;
    if (usedBytes + entry.bytes > config.maxBytes) return;
    usedBytes += entry.bytes;
    picked.set(m.inputSeq, {
      messageId: m.messageId,
      inputSeq: m.inputSeq,
      text: m.text,
      reason,
      effectiveImpact: entry.effectiveImpact,
      duplicateFactor: entry.factor,
    });
  };
  for (const entry of scored) {
    if (entry.message.persistent) tryAdd(entry, "persistent");
  }
  let taken = 0;
  for (const entry of [...scored].reverse()) {
    if (taken >= config.recentCount) break;
    if (picked.has(entry.message.inputSeq)) continue;
    const before = picked.size;
    tryAdd(entry, "recent");
    if (picked.size > before) taken += 1;
  }
  const byImpact = scored
    .filter((entry) => !picked.has(entry.message.inputSeq))
    .sort(
      (a, b) => b.effectiveImpact - a.effectiveImpact || b.message.inputSeq - a.message.inputSeq,
    );
  taken = 0;
  for (const entry of byImpact) {
    if (taken >= config.highImpactCount) break;
    const before = picked.size;
    tryAdd(entry, "high-impact");
    if (picked.size > before) taken += 1;
  }
  const items = [...picked.values()].sort((a, b) => a.inputSeq - b.inputSeq);
  return { items, totalBytes: usedBytes };
};
