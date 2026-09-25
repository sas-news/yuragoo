import { z } from "zod";

const providerError = <K extends string>(kind: K) =>
  z.strictObject({
    kind: z.literal(kind),
    message: z.string(),
    retryable: z.boolean(),
  });

export const decisionProviderErrorSchema = z.discriminatedUnion("kind", [
  providerError("invalid-response"),
  providerError("unavailable"),
  providerError("timeout"),
  providerError("budget"),
]);
export type DecisionProviderError = z.infer<typeof decisionProviderErrorSchema>;

export type DecisionContractErrorKind = "invalid-state" | "invalid-response";

export class DecisionContractError extends Error {
  readonly kind: DecisionContractErrorKind;

  constructor(kind: DecisionContractErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecisionContractError";
    this.kind = kind;
  }
}
