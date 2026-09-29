// One-shot sanity probe for the ending-generation wire shape (Task 31):
// posts ONE synthetic ending input at GENERATION_UPSTREAM_URL using the
// real HttpGenerativeProvider, or prints the exact request it would send
// when the URL is unset. No retries, no auth — this only exercises the
// schema/prompt contract against a live fixture.
import {
  buildEndingPrompt,
  type EndingGenerationInput,
  endingJsonSchema,
  HttpGenerativeProvider,
  jevOutboundFetch,
} from "@yuragoo/ai";

const input: EndingGenerationInput = {
  scenario: "夜のおやつ会議",
  outcome: { kind: "winner", winnerLabel: "プリンをかくす", noContestReason: null },
  panels: [
    {
      kind: "start",
      eventId: 1,
      quotes: [{ postId: "p1", text: "こっそりキッチンへ行く" }],
    },
    {
      kind: "impact",
      eventId: 4,
      quotes: [{ postId: "p7", text: "プリンをぜんぶかくす" }],
    },
    {
      kind: "result",
      eventId: 9,
      quotes: [{ postId: "p12", text: "だれも見つけられなかった" }],
    },
  ],
};

const request = {
  prompt: buildEndingPrompt(input),
  kind: "ending" as const,
  jsonSchema: endingJsonSchema(input.panels.map((p) => p.eventId)),
  count: input.panels.length,
};

const url = process.env.GENERATION_UPSTREAM_URL?.trim() ?? "";
if (url === "") {
  console.log("GENERATION_UPSTREAM_URL unset — request that would be sent:");
  console.log(JSON.stringify(request, null, 2));
  process.exit(0);
}
const provider = new HttpGenerativeProvider({ url, fetch: jevOutboundFetch });
const response = await provider.generate(request);
console.log(JSON.stringify(response, null, 2));
