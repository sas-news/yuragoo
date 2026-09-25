// CLI for the Japanese JEV behavior-evaluation gate. Reads a suite from
// tests/jev-evals/<name>.json, drives it through the live provider when
// JEV_API_KEY is set, and always writes a verdict manifest to --out.
// Exit codes: 0 pass, 1 fail (or usage error), 2 blocked (no API key).
// Never prints the key, request bodies or case text.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultSleep,
  InMemoryAttemptQuota,
  JevDecisionProvider,
  jevOutboundFetch,
  parseEvalSuite,
  runEvalSuite,
} from "@yuragoo/ai";

const USAGE =
  "usage: bun run eval:jev -- --suite <name> --max-attempts <n> --out <path> [--timeout-ms <n>]";
function die(message: string): never {
  throw new Error(message);
}
const args = (argv: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (!arg.startsWith("--")) die(`unexpected argument "${arg}"`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) die(`--${key} needs a value`);
    if (out.has(key)) die(`--${key} given twice`);
    out.set(key, value);
    i += 1;
  }
  return out;
};
const positiveInt = (value: string | undefined, flag: string): number => {
  const n = Number(value);
  if (value === undefined || !Number.isSafeInteger(n) || n <= 0) {
    die(`${flag} must be a positive integer`);
  }
  return n;
};

// FNV-1a 32-bit over the JSON request body — a stable, dependency-free
// fingerprint for correlating manifest records without storing the body.
const fnv1a = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

const main = async (): Promise<number> => {
  const opts = args(Bun.argv.slice(2));
  const suiteName = opts.get("suite") ?? die("--suite is required");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(suiteName)) die("--suite must match [a-zA-Z0-9_-]{1,64}");
  const maxAttempts = positiveInt(opts.get("max-attempts"), "--max-attempts");
  const timeoutMs = positiveInt(opts.get("timeout-ms") ?? "3000", "--timeout-ms");
  const outPath = opts.get("out") ?? die("--out is required");
  const known = new Set(["suite", "max-attempts", "timeout-ms", "out"]);
  for (const key of opts.keys()) {
    if (!known.has(key)) die(`unknown flag --${key}`);
  }
  const suitePath = join("tests", "jev-evals", `${suiteName}.json`);
  const suite = parseEvalSuite(JSON.parse(readFileSync(suitePath, "utf8")));
  const apiKey = process.env.JEV_API_KEY?.trim() ?? "";
  const day = new Date().toISOString().slice(0, 10);
  const provider =
    apiKey === ""
      ? null
      : new JevDecisionProvider({
          apiKey,
          sessionId: `eval-${suiteName.slice(0, 40)}-${day}`,
          quota: new InMemoryAttemptQuota({
            dailyAttemptCap: maxAttempts,
            perSessionAttemptCap: maxAttempts,
          }),
          timeoutMs,
          fetch: jevOutboundFetch,
          nowMs: Date.now,
          sleep: defaultSleep,
        });
  const manifest = await runEvalSuite(suite, provider, {
    nowMs: Date.now,
    hashRequest: (body) => fnv1a(JSON.stringify(body)),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (manifest.verdict === "blocked") {
    console.log("BLOCKED: JEV_API_KEY not set");
    return 2;
  }
  const summary = `${manifest.verdict} ${manifest.passingCases}/${manifest.totalCases} cases, p95=${manifest.p95LatencyMs}ms`;
  console.log(summary);
  return manifest.verdict === "pass" ? 0 : 1;
};

try {
  process.exit(await main());
} catch (error) {
  console.error(`eval-jev: ${error instanceof Error ? error.message : String(error)}`);
  console.error(USAGE);
  process.exit(1);
}
