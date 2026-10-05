// Shared JEV wire constants (split to break the decision ↔
// decision-response import cycle at the loc limit): the model tag and
// the mood vocabulary both sides of the contract must agree on.
import { z } from "zod";

export const jevModelSchema = z.literal("jev-1.13.0");
export type JevModel = z.infer<typeof jevModelSchema>;

// The creature's mood vocabulary (Task 43): Jev answers a SECOND choice
// question on the same state — same request, same quota slot — so the face
// is the model's verdict rather than a shape heuristic over the pull.
// These ids intentionally mirror creature's CreatureExpression; keeping
// the list here (not an import) is what lets the wire name them.
export const MOOD_IDS = ["rest", "hesitating", "engaged", "bored", "adhering"] as const;
export const moodIdSchema = z.enum(MOOD_IDS);
export type MoodId = z.infer<typeof moodIdSchema>;
