// Generative providers (Task 25). Exactly one real upstream exists —
// the Workers AI binding (@cf/qwen/qwen3-30b-a3b-fp8 per plan ref G1:
// temperature 0.6, max_tokens 1024, stream=false, JSON-schema output).
// LOCAL/dev/test NEVER call it: HttpGenerativeProvider posts the same
// input shape to a fixture URL (GENERATION_UPSTREAM_URL seam, mirroring
// JEV_UPSTREAM_URL), and MockGenerativeProvider is the deterministic
// no-network default for local dev. There is no automatic retry anywhere
// in this file — one click is at most one attempt.
import {
  type GenerationRequest,
  GenerationProviderError,
  type GenerativeProvider,
} from "./generative-provider";

export const CHOICE_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

// The Workers AI call shape (shared by the binding impl and the fixture
// HTTP impl so the e2e stand-in emulates env.AI.run faithfully).
const modelInput = (request: GenerationRequest): Record<string, unknown> => ({
  messages: [{ role: "user", content: request.prompt }],
  max_tokens: 1024,
  temperature: 0.6,
  stream: false,
  response_format: { type: "json_schema", json_schema: request.jsonSchema },
});

// Workers AI wraps model output in `response` (a parsed object when a
// schema was supplied, text otherwise). Anything else passes through so
// the parser downstream decides.
const unwrap = (result: unknown): unknown =>
  result !== null && typeof result === "object" && "response" in result
    ? (result as { response: unknown }).response
    : result;

// The narrow slice of the env.AI binding this provider uses.
export interface WorkersAiRun {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export class WorkersAiGenerativeProvider implements GenerativeProvider {
  constructor(
    private readonly ai: WorkersAiRun,
    private readonly model: string = CHOICE_MODEL,
  ) {}

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    // The binding takes no AbortSignal — the caller races its deadline
    // around this call, and the post-await check maps a late resolution.
    const result = await this.ai.run(this.model, modelInput(request));
    signal?.throwIfAborted();
    return unwrap(result);
  }
}

export interface HttpGenerativeProviderOptions {
  readonly url: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

// Fixture seam: POSTs {model, ...modelInput} and unwraps {response} the
// same way — an e2e/local stand-in answers whatever it likes.
export class HttpGenerativeProvider implements GenerativeProvider {
  constructor(private readonly options: HttpGenerativeProviderOptions) {}

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const res = await this.options.fetch(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: CHOICE_MODEL, ...modelInput(request) }),
      signal: signal ?? null,
    });
    signal?.throwIfAborted();
    if (res.status < 200 || res.status >= 300) {
      throw new GenerationProviderError("upstream", `upstream responded ${res.status}`);
    }
    return unwrap(await res.json());
  }
}

// Deterministic local default (APP_ENV=local without a fixture URL):
// returns contract-valid labels derived from the request count so dev
// pages exercise the full proposal flow without any network call.
export class MockGenerativeProvider implements GenerativeProvider {
  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return {
      choices: Array.from({ length: request.count }, (_, i) => `サンプル案${i + 1}`),
    };
  }
}
