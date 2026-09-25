// The production Worker keeps its planned compatibility date; the older
// date used by the local workerd binary lives only in vitest.workers.config.
// Task 17 moved the config to wrangler.jsonc to carry the GameRoom
// durable_objects binding and its SQLite migration.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

test("happy: production wrangler keeps compatibility_date 2026-09-19", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const jsonc = readFileSync(`${root}apps/server/wrangler.jsonc`, "utf8");
  expect(jsonc).toContain('"compatibility_date": "2026-09-19"');
  expect(jsonc).toContain('"class_name": "GameRoom"');
  expect(jsonc).toContain('"new_sqlite_classes": ["GameRoom"]');
  const vitest = readFileSync(`${root}vitest.workers.config.ts`, "utf8");
  expect(vitest).toContain('compatibilityDate: "2026-08-22"');
});
