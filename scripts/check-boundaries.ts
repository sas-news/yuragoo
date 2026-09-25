import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VirtualFile {
  readonly path: string;
  readonly source: string;
}

export type BoundaryRule =
  | "import-boundary"
  | "core-purity"
  | "secret-exposure"
  | "server-runtime"
  | "loc-limit";

export interface Violation {
  readonly path: string;
  readonly line: number;
  readonly rule: BoundaryRule;
  readonly message: string;
}

const MAX_LOC = 250;

const ALLOWED_EDGES: Readonly<Record<string, ReadonlySet<string>>> = {
  "@yuragoo/protocol": new Set(),
  "@yuragoo/game-core": new Set(["@yuragoo/protocol"]),
  "@yuragoo/creature": new Set(["@yuragoo/protocol"]),
  "@yuragoo/ai": new Set(["@yuragoo/protocol"]),
  "@yuragoo/platform": new Set(["@yuragoo/protocol"]),
  "@yuragoo/web": new Set([
    "@yuragoo/protocol",
    "@yuragoo/game-core",
    "@yuragoo/creature",
    "@yuragoo/platform",
    "@yuragoo/ai",
  ]),
  "@yuragoo/server": new Set([
    "@yuragoo/protocol",
    "@yuragoo/game-core",
    "@yuragoo/ai",
    "@yuragoo/platform",
  ]),
};

const CORE_FORBIDDEN_SPECIFIERS = [
  /^react($|\/|-)/,
  /^pixi\.js($|\/)/,
  /^@?discord/i,
  /^@cloudflare\//,
  /^hono($|\/)/,
  /^ky($|\/)/,
  /^node:/,
  /^bun($|\/)/,
];

const CORE_FORBIDDEN_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBun\./, "Bun.* APIs"],
  [/\bprocess\./, "process.* APIs"],
  [/\bfetch\s*\(/, "fetch()"],
  [/\brequire\s*\(/, "require()"],
];

const SECRET_ENV_RE = /\b(?:VITE|PUBLIC)_[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*\b/g;

const CLIENT_REACHABLE_RE = /^apps\/web\/|^packages\/(protocol|game-core|creature|platform)\//;

const SPECIFIER_RE =
  /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".omo",
  ".codegraph",
  "dist",
  "build",
  "coverage",
  ".vite",
  ".wrangler",
]);

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function ownerOf(path: string): string | null {
  const seg = path.split("/");
  if ((seg[0] === "packages" || seg[0] === "apps") && seg[1]) {
    return `@yuragoo/${seg[1]}`;
  }
  return null;
}

function resolveRelative(fromPath: string, spec: string): string {
  const parts = fromPath.split("/");
  parts.pop();
  for (const p of spec.split("/")) {
    if (p === "..") {
      parts.pop();
    } else if (p !== "." && p !== "") {
      parts.push(p);
    }
  }
  return parts.join("/");
}

function internalTarget(fromPath: string, spec: string): string | null {
  if (spec.startsWith("@yuragoo/")) {
    return `@yuragoo/${spec.split("/")[1]}`;
  }
  if (spec.startsWith(".")) {
    return ownerOf(resolveRelative(fromPath, spec));
  }
  return null;
}

export function importsOf(source: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  for (const m of source.matchAll(SPECIFIER_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) {
      out.push({ spec, line: lineAt(source, m.index) });
    }
  }
  return out;
}

export function checkFiles(files: readonly VirtualFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    const source = file.source;
    const owner = ownerOf(path);
    const push = (line: number, rule: BoundaryRule, message: string) =>
      violations.push({ path, line, rule, message });

    if (source.split("\n").length > MAX_LOC) {
      push(MAX_LOC + 1, "loc-limit", `handwritten source exceeds ${MAX_LOC} lines`);
    }

    for (const { spec, line } of importsOf(source)) {
      const target = internalTarget(path, spec);
      if (owner && target && target !== owner && !ALLOWED_EDGES[owner]?.has(target)) {
        push(line, "import-boundary", `${owner} may not depend on ${target} (${spec})`);
      }
      if (owner === "@yuragoo/game-core" && CORE_FORBIDDEN_SPECIFIERS.some((re) => re.test(spec))) {
        push(line, "core-purity", `game-core may not import ${spec}`);
      }
      if (path.startsWith("apps/server/") && spec.startsWith("node:")) {
        push(line, "server-runtime", `server code may not import Node-only module ${spec}`);
      }
    }

    if (owner === "@yuragoo/game-core") {
      for (const [re, label] of CORE_FORBIDDEN_TOKENS) {
        const m = re.exec(source);
        if (m) push(lineAt(source, m.index), "core-purity", `game-core may not use ${label}`);
      }
    }

    if (path.startsWith("apps/server/")) {
      const m = /\bBun\.serve\b/.exec(source);
      if (m) push(lineAt(source, m.index), "server-runtime", "server code may not use Bun.serve");
    }

    for (const m of CLIENT_REACHABLE_RE.test(path) ? source.matchAll(SECRET_ENV_RE) : []) {
      push(
        lineAt(source, m.index),
        "secret-exposure",
        `public env name ${m[0]} may not carry secret material`,
      );
    }
  }
  return violations;
}

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collect(join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
}

if (import.meta.main) {
  const paths: string[] = [];
  collect(".", paths);
  const violations = checkFiles(paths.map((p) => ({ path: p, source: readFileSync(p, "utf8") })));
  for (const v of violations) {
    console.error(`${v.path}:${v.line} [${v.rule}] ${v.message}`);
  }
  if (violations.length > 0) {
    console.error(`check-boundaries: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(`check-boundaries: ${paths.length} files scanned, 0 violations`);
}
