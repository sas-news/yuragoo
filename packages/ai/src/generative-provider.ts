// Generic generative-model provider seam (Task 25): one-shot text->JSON
// generation behind an injectable interface, mirroring DecisionProvider.
// Implementations: WorkersAiGenerativeProvider (production binding),
// HttpGenerativeProvider (local/e2e fixture URL) and MockGenerativeProvider
// (deterministic local default) — all in ./workers-ai-provider.

// Which prompt family a request belongs to — mocks/fixtures cannot parse
// schemas, so the kind rides plainly and lets them shape a valid reply.
export type GenerationKind = "choices" | "scenario" | "ending";

export interface GenerationRequest {
  // The fully-built prompt text (UTF-8; callers keep it under the model's
  // input cap — the choice prompt stays well below 12KiB).
  readonly prompt: string;
  readonly kind: GenerationKind;
  // The JSON schema the model must answer with (structured output).
  readonly jsonSchema: Record<string, unknown>;
  // The expected label count — the schema already encodes it, but mocks
  // and fixtures cannot always parse schemas, so it rides along plainly.
  readonly count: number;
}

export interface GenerativeProvider {
  // Resolves with the model's response payload — an already-parsed object
  // for schema mode, or a JSON string when the upstream only gives text.
  generate(request: GenerationRequest, signal?: AbortSignal): Promise<unknown>;
}

export type GenerationErrorKind = "config" | "upstream" | "timeout" | "invalid-response";

export class GenerationProviderError extends Error {
  readonly kind: GenerationErrorKind;

  constructor(kind: GenerationErrorKind, message: string) {
    super(message);
    this.name = "GenerationProviderError";
    this.kind = kind;
  }
}
