// Task 25 e2e fixture: the deterministic Workers AI stand-in. The
// worker's GENERATION_UPSTREAM_URL binding points the one-shot choice
// generation at this local server so e2e NEVER touches the real paid
// model. It answers the same shape HttpGenerativeProvider posts
// ({model, messages, response_format:{json_schema}}) with the same
// unwrap convention ({response: ...}).
//
//   mode "ok"      -> {response: {choices: [生成フィクスチャ案N x count]}}
//                     where count comes from the schema's maxItems
//                     — or, when the request schema asks for story
//                     panels ({eventId} enum), {response: {title,
//                     panels: every enum id captioned}} so the post-
//                     game ending call gets its all-or-nothing reply
//                     — or, when the schema asks for {scenario}, a
//                     fixed お題 string (Task 44 scenario generation)
//   mode "garbage" -> {response: <non-JSON text>} — parse fails, the
//                     attempt is still spent (send happened)
// Every request line is logged for the failure evidence file.
import { createServer } from "node:http";

export interface GenerationFixture {
  readonly url: string;
  readonly requests: readonly string[];
  mode: "ok" | "garbage" | "hold";
  releaseHeld(): void;
  close(): Promise<void>;
}

export const startGenerationFixture = (port = 8792): Promise<GenerationFixture> => {
  const held: (() => void)[] = [];
  const state = { mode: "ok" as "ok" | "garbage" | "hold", requests: [] as string[] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      state.requests.push(`${new Date().toISOString()} ${req.method} ${req.url} ${body}`);
      let count = 4;
      let panelIds: number[] | null = null;
      let wantsScenario = false;
      try {
        const parsed = JSON.parse(body) as {
          response_format?: {
            json_schema?: {
              properties?: {
                choices?: { maxItems?: number };
                panels?: { items?: { properties?: { eventId?: { enum?: unknown } } } };
                scenario?: unknown;
              };
            };
          };
        };
        const props = parsed.response_format?.json_schema?.properties;
        count = props?.choices?.maxItems ?? 4;
        const ids = props?.panels?.items?.properties?.eventId?.enum;
        // The ending schema carries the allowed eventIds as an integer
        // enum — a number-array enum means this call is the post-game
        // story generation, not the lobby choice generation.
        if (Array.isArray(ids) && ids.every((id) => typeof id === "number")) {
          panelIds = ids;
        }
        // Task 44: a {scenario} property marks the お題-generation call.
        wantsScenario = props?.scenario !== undefined;
      } catch {
        // Fall through — a malformed request still gets a shaped answer.
      }
      const answer = (): void => {
        res.setHeader("content-type", "application/json");
        if (state.mode === "garbage") {
          // A bare string parses as a VALID scenario (the parser accepts
          // plain text), so scenario garbage needs a non-string shape.
          res.end(
            JSON.stringify({
              response: wantsScenario ? 42 : "この返答はJSONの選択肢ではありません",
            }),
          );
          return;
        }
        if (wantsScenario) {
          res.end(JSON.stringify({ response: { scenario: "雨の日のピクニック大作戦" } }));
          return;
        }
        if (panelIds !== null) {
          res.end(
            JSON.stringify({
              response: {
                title: "よるのおやつものがたり",
                panels: panelIds.map((eventId) => ({
                  eventId,
                  caption: `ばめん${eventId}`,
                })),
              },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            response: {
              choices: Array.from({ length: count }, (_, i) => `生成案${i + 1}`),
            },
          }),
        );
      };
      // "hold" parks the normal answer so tests can act mid-generation —
      // release delivers the real shaped response (never a silent hang).
      if (state.mode === "hold") {
        held.push(answer);
        return;
      }
      answer();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}/choices`,
        requests: state.requests,
        get mode() {
          return state.mode;
        },
        set mode(m: "ok" | "garbage" | "hold") {
          state.mode = m;
        },
        releaseHeld: () => {
          for (const release of held.splice(0)) release();
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
};
