// Task 25 e2e fixture: the deterministic Workers AI stand-in. The
// worker's GENERATION_UPSTREAM_URL binding points the one-shot choice
// generation at this local server so e2e NEVER touches the real paid
// model. It answers the same shape HttpGenerativeProvider posts
// ({model, messages, response_format:{json_schema}}) with the same
// unwrap convention ({response: ...}).
//
//   mode "ok"      -> {response: {choices: [生成フィクスチャ案N x count]}}
//                     where count comes from the schema's maxItems
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
      try {
        const parsed = JSON.parse(body) as {
          response_format?: { json_schema?: { properties?: { choices?: { maxItems?: number } } } };
        };
        count = parsed.response_format?.json_schema?.properties?.choices?.maxItems ?? 4;
      } catch {
        // Fall through — a malformed request still gets a shaped answer.
      }
      const answer = (): void => {
        res.setHeader("content-type", "application/json");
        if (state.mode === "garbage") {
          res.end(JSON.stringify({ response: "この返答はJSONの選択肢ではありません" }));
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
