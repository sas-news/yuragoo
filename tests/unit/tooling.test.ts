import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlayerName, playerNameSchema } from "@yuragoo/protocol";
import { checkFiles } from "../../scripts/check-boundaries";

const rulesOf = (files: { path: string; source: string }[]) =>
  new Set(checkFiles(files).map((v) => v.rule));

test("happy: schema-derived type is assignable and parses at runtime", () => {
  // Given a Zod v4 schema exported from @yuragoo/protocol
  // When a valid display name is parsed
  const parsed = playerNameSchema.parse("あいこ");
  // Then the inferred TypeScript type accepts the runtime result
  const name: PlayerName = parsed;
  expect(name).toBe("あいこ");
  expect(playerNameSchema.safeParse("").success).toBe(false);
});

test("happy: an allowed internal import graph produces zero violations", () => {
  // Given virtual sources that only use edges permitted by the workspace DAG
  const files = [
    {
      path: "packages/game-core/src/rules.ts",
      source:
        'import { protocolVersion } from "@yuragoo/protocol";\nexport const v = protocolVersion;',
    },
    {
      path: "apps/web/src/main.tsx",
      source:
        'import { gameRulesVersion } from "@yuragoo/game-core";\nimport { rendererVersion } from "@yuragoo/creature";\nexport { gameRulesVersion, rendererVersion };',
    },
    {
      path: "apps/server/src/index.ts",
      source:
        'import type { PlatformKind } from "@yuragoo/platform";\nexport type { PlatformKind };',
    },
  ];
  // When the boundary checker runs
  // Then no violations are reported
  expect(checkFiles(files)).toEqual([]);
});

test("failure: game-core importing React is rejected", () => {
  // Given a game-core source that imports a prohibited runtime
  const files = [
    {
      path: "packages/game-core/src/view.ts",
      source: 'import React from "react";\nexport const r = React;',
    },
  ];
  // When checked, Then a core-purity violation is reported
  expect(rulesOf(files).has("core-purity")).toBe(true);
});

test("failure: an internal import edge outside the DAG is rejected", () => {
  // Given protocol (leaf package) importing game-core, which it may not depend on
  const files = [
    {
      path: "packages/protocol/src/up.ts",
      source:
        'import { gameRulesVersion } from "@yuragoo/game-core";\nexport const g = gameRulesVersion;',
    },
  ];
  // When checked, Then an import-boundary violation is reported
  expect(rulesOf(files).has("import-boundary")).toBe(true);
});

test("failure: secret-bearing public env names are rejected", () => {
  // Given client-visible env identifiers carrying secret material
  const files = [
    {
      path: "apps/web/src/env.ts",
      source: "export const s = import.meta.env.VITE_JEV_SECRET_KEY;",
    },
    { path: "apps/web/src/env2.ts", source: "export const t = process.env.PUBLIC_API_TOKEN;" },
  ];
  // When checked, Then a secret-exposure violation is reported for each file
  const violations = checkFiles(files).filter((v) => v.rule === "secret-exposure");
  expect(violations.length).toBe(2);
});

test("failure: server product code using Node APIs or Bun.serve is rejected", () => {
  // Given server sources relying on Node-only APIs and Bun.serve
  const files = [
    {
      path: "apps/server/src/fs.ts",
      source: 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;',
    },
    { path: "apps/server/src/serve.ts", source: 'Bun.serve({ fetch: () => new Response("ok") });' },
  ];
  // When checked, Then a server-runtime violation is reported for each file
  const violations = checkFiles(files).filter((v) => v.rule === "server-runtime");
  expect(violations.length).toBe(2);
});

test("failure: handwritten source over 250 LOC is rejected", () => {
  // Given a virtual handwritten file with 251 physical lines
  const files = [
    {
      path: "packages/game-core/src/big.ts",
      source: Array(251).fill("export const x = 1;").join("\n"),
    },
  ];
  // When checked, Then a loc-limit violation is reported
  expect(rulesOf(files).has("loc-limit")).toBe(true);
});

test("failure: a requested test selection resolving to zero tests exits nonzero", () => {
  // Given a temporary file that contains no tests
  const dir = mkdtempSync(join(tmpdir(), "yuragoo-zero-"));
  const file = join(dir, "empty.test.ts");
  writeFileSync(file, "export const nothing = 1;\n");
  try {
    // When the test:unit seam is invoked on that selection
    const proc = Bun.spawnSync([process.execPath, "scripts/test-unit.ts", file], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Then it fails nonzero instead of silently passing
    expect(proc.exitCode).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
