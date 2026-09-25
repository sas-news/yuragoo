import { z } from "zod";

export const protocolVersion = 1;
export const schemaVersion = 1;

export const playerNameSchema = z.string().trim().min(1).max(24);
export type PlayerName = z.infer<typeof playerNameSchema>;

export * from "./ids";
export * from "./errors";
export * from "./decision";
export * from "./lobby";
export * from "./text";
export * from "./snapshot";
export * from "./client-messages";
export * from "./server-messages";
