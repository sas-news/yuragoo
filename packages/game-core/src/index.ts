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
