import { protocolVersion } from "@yuragoo/protocol";

export const gameRulesVersion = 1;
export const supportedProtocolVersion = protocolVersion;

export * from "./settings";
export * from "./state";
export * from "./commands";
export * from "./outcome";
export * from "./settlement";
export * from "./early-decision";
export * from "./turn";
export * from "./live";
export * from "./reducer";

// Task 29: deterministic ending-story extraction. Only the public builder
// and the source/row shapes are exported — scoring internals stay private.
export { buildStory } from "./story/panels";
export type { StoryEventRow, StorySource } from "./story/highlights";
