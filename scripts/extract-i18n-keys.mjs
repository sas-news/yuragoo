// Extract every JA-source i18n key: string literals passed to t()/tx()
// plus literals inside known key-holding tables. Prints unique keys with
// the files they came from so en.ts can be reviewed/filled by hand.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../apps/web/src", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const SKIP_DIRS = new Set(["dev"]); // /dev tools stay JA-only (not in prod bundle)
// Hiragana/katakana catch most copy, but kanji-only keys exist too
// (準備OK, 利用規約, {n}人) — include Han so nothing silently drops.
const JA = /[\p{Script=Hiragana}\p{Script=Katakana}ー\p{Script=Han}]/u;

const files = [];
const walk = (dir) => {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(ent)) walk(p);
    } else if (/\.(ts|tsx)$/.test(ent) && !/\.test\.|\.spec\./.test(ent)) {
      files.push(p);
    }
  }
};
walk(ROOT);

const keys = new Map(); // key -> Set<file>
const add = (key, file) => {
  if (!JA.test(key)) return;
  if (!keys.has(key)) keys.set(key, new Set());
  keys.get(key).add(relative(ROOT, file));
};

for (const file of files) {
  // Strip // comments first — doc examples like t("…日本語…") are not keys.
  const src = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
  // t("…") / tx(x, "…") / translate(x, "…") call args (double-quoted only).
  for (const m of src.matchAll(
    /\b(?:t|tx|translate)\(\s*(?:[^,()"'`]+,\s*)?"((?:[^"\\]|\\.)*)"/g,
  )) {
    add(JSON.parse(`"${m[1]}"`), file);
  }
  // Key-holding tables: JA string values in .ts modules that feed t()
  // indirectly (error maps, gate reasons, platform copy). scenario-presets
  // is excluded on purpose — presets are shared room content that follows
  // the room language table, never the viewer dictionary.
  if (/lobby-errors|lobby-gate|creatureStatus|LocalResult|view-members/.test(file)) {
    for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const v = JSON.parse(`"${m[1]}"`);
      if (JA.test(v) && !v.startsWith("data:")) add(v, file);
    }
  }
}

// Platform package copy keys (discordErrorCopy output is wrapped in t()).
const PF = new URL("../packages/platform/src/discord-errors.ts", import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  "$1",
);
for (const m of readFileSync(PF, "utf8").matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
  const v = JSON.parse(`"${m[1]}"`);
  if (JA.test(v)) add(v, PF);
}

const sorted = [...keys.entries()].sort(([a], [b]) => a.localeCompare(b, "ja"));
if (process.argv.includes("--write")) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(".omo/i18n-keys.json", JSON.stringify(sorted.map(([k]) => k)));
  console.error(`wrote .omo/i18n-keys.json (${sorted.length} keys)`);
} else {
  for (const [key, from] of sorted) {
    console.log(JSON.stringify(key));
    for (const f of from) console.log(`    ${f}`);
  }
  console.error(`\n${sorted.length} keys`);
}
