// Text normalization and near-duplicate attenuation for accepted inputs.
// Pure string processing: NFKC, case folding, alias mapping and character
// bigram Dice similarity — no AI or embedding calls.

const SALE_ALIAS = /50\s*%\s*off|半額/g;

// NFKC folds full-width digits/letters (５０％ＯＦＦ -> 50%OFF); the alias
// rule then maps every "50% off" spelling onto the canonical 半額 token
// before punctuation and symbol spacing are stripped.
export const normalizeForDuplicate = (text: string): string => {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(SALE_ALIAS, "半額")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const bigrams = (s: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (s.length === 1) {
    counts.set(s, 1);
    return counts;
  }
  for (let i = 0; i + 1 < s.length; i += 1) {
    const gram = s.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
};

// Multiset character-bigram Dice similarity: identical normalized text is 1,
// two empty texts are 1, and every result is finite inside [0, 1].
export const bigramSimilarity = (a: string, b: string): number => {
  const na = normalizeForDuplicate(a);
  const nb = normalizeForDuplicate(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let shared = 0;
  let total = 0;
  for (const [gram, count] of ga) {
    shared += Math.min(count, gb.get(gram) ?? 0);
    total += count;
  }
  for (const count of gb.values()) total += count;
  return total === 0 ? 0 : (2 * shared) / total;
};

export interface DuplicateAttenuation {
  readonly factor: number;
  readonly maxSimilarity: number;
}

// Compares against at most the latest 12 recent texts. Similarity below 0.55
// leaves impact untouched; at 1.0 the factor reaches the 0.2 floor.
export const duplicateAttenuation = (
  text: string,
  recentTexts: readonly string[],
): DuplicateAttenuation => {
  let maxSimilarity = 0;
  for (const recent of recentTexts.slice(-12)) {
    maxSimilarity = Math.max(maxSimilarity, bigramSimilarity(text, recent));
  }
  const factor =
    maxSimilarity < 0.55
      ? 1
      : Math.min(1, Math.max(0.2, 1 - ((maxSimilarity - 0.55) / 0.45) * 0.8));
  return { factor, maxSimilarity };
};
