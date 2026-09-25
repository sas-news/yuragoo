import { z } from "zod";
import { DecisionContractError } from "./errors";

export const choiceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .brand("ChoiceId");
export type ChoiceId = z.infer<typeof choiceIdSchema>;

export const decisionRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .brand("DecisionRevision");
export type DecisionRevision = z.infer<typeof decisionRevisionSchema>;

export const parseChoiceId = (input: unknown): ChoiceId => {
  const result = choiceIdSchema.safeParse(input);
  if (!result.success) {
    throw new DecisionContractError("invalid-state", "choice id failed validation");
  }
  return result.data;
};

export const parseDecisionRevision = (input: unknown): DecisionRevision => {
  const result = decisionRevisionSchema.safeParse(input);
  if (!result.success) {
    throw new DecisionContractError("invalid-state", "decision revision failed validation");
  }
  return result.data;
};
