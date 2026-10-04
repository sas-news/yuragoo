// parseChoiceLabels contract (Task 25/48): the provider's payload is
// normalized before validation — ```json fences, surrounding prose and
// {label} entries are real Qwen output quirks; count/empty/length/dupes
// still hard-reject so a bad batch frees the room's generation slot.
import { expect, test } from "vitest";
import { parseChoiceLabels } from "@yuragoo/ai";
import { GenerationProviderError } from "@yuragoo/ai";

const labels = (n: number) => Array.from({ length: n }, (_, i) => `案${i + 1}`);

test("canonical shapes: choices object, bare array, JSON string", () => {
  expect(parseChoiceLabels({ choices: labels(3) }, 3)).toEqual(labels(3));
  expect(parseChoiceLabels(labels(2), 2)).toEqual(labels(2));
  expect(parseChoiceLabels(JSON.stringify({ choices: labels(4) }), 4)).toEqual(labels(4));
});

test("tolerant: markdown fences and surrounding prose are sliced out", () => {
  const fenced = `\`\`\`json\n${JSON.stringify({ choices: labels(2) })}\n\`\`\``;
  expect(parseChoiceLabels(fenced, 2)).toEqual(labels(2));
  const chatty = `はい、お作りしました！\n${JSON.stringify({ choices: labels(2) })}\n以上です`;
  expect(parseChoiceLabels(chatty, 2)).toEqual(labels(2));
});

test("tolerant: {label} entries unwrap to their label string", () => {
  const raw = { choices: [{ label: "案A" }, { label: "案B" }] };
  expect(parseChoiceLabels(raw, 2)).toEqual(["案A", "案B"]);
});

test("tolerant: double wraps and over-produced arrays normalize", () => {
  // {response: JSON.stringify({choices})} — a stringify level deeper.
  expect(parseChoiceLabels({ response: JSON.stringify({ choices: labels(2) }) }, 2)).toEqual(
    labels(2),
  );
  // Over-production keeps the first `count`; labels stay distinct so it lands.
  expect(parseChoiceLabels({ choices: [...labels(2), "案3", "案4"] }, 2)).toEqual(labels(2));
});

test("tolerant: alternate envelopes, dict choices and {text} entries", () => {
  // A lone array-valued key stands in for `choices` ({"候補": [...]}).
  expect(parseChoiceLabels({ 候補: labels(2) }, 2)).toEqual(labels(2));
  // Nested carriers: {result: {response: {choices}}}.
  expect(parseChoiceLabels({ result: { response: { choices: labels(2) } } }, 2)).toEqual(labels(2));
  // {choices: {"1": "...", ...}} — a dict of strings flattens to values.
  expect(parseChoiceLabels({ choices: { "1": "案A", "2": "案B" } }, 2)).toEqual(["案A", "案B"]);
  // Entry objects reach for other field names; any string property lands.
  const raw = { choices: [{ text: "案A" }, { choice: "案B" }] };
  expect(parseChoiceLabels(raw, 2)).toEqual(["案A", "案B"]);
});

test("tolerant: non-JSON text is treated as a bullet/comma list", () => {
  expect(parseChoiceLabels("1. 案A\n2. 案B", 2)).toEqual(["案A", "案B"]);
  expect(parseChoiceLabels("・案A\n・案B", 2)).toEqual(["案A", "案B"]);
  expect(parseChoiceLabels("案A、案B", 2)).toEqual(["案A", "案B"]);
});

test("strict: wrong count, empty, overlong and duplicate labels reject", () => {
  const bad = (raw: unknown, n: number) => () => parseChoiceLabels(raw, n);
  expect(bad({ choices: labels(1) }, 2)).toThrow(GenerationProviderError); // under-production
  expect(bad({ response: { unrelated: true } }, 2)).toThrow(GenerationProviderError); // no choices
  expect(bad({ choices: ["案A", "  "] }, 2)).toThrow(GenerationProviderError);
  expect(bad({ choices: ["あ".repeat(41), "案B"] }, 2)).toThrow(GenerationProviderError);
  expect(bad({ choices: ["案A", "案A"] }, 2)).toThrow(GenerationProviderError);
  expect(bad("not-json-at-all", 2)).toThrow(GenerationProviderError);
});
