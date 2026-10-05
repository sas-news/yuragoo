import { readdirSync, readFileSync } from "node:fs";
const keys = JSON.parse(readFileSync(".omo/i18n-keys.json", "utf8"));
const files = ["apps/web/src/i18n/en.ts"];
for (const f of readdirSync("apps/web/src/i18n/en")) {
  files.push(`apps/web/src/i18n/en/${f}`);
}
// Biome's quoteStyle:"asNeeded" strips quotes from keys that are valid
// identifiers (bare Japanese reads as one) — match both forms.
const dict = new Set();
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/^ {2}(?:"((?:[^"\\]|\\.)*)"|([^":\r\n][^":\r\n]*?))\s*:/gm)) {
    dict.add(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
  }
}
process.stdout.write(`dict=${dict.size} keys=${keys.length}\n`);
const missing = keys.filter((k) => !dict.has(k));
process.stdout.write(`missing=${missing.length}\n`);
for (const k of missing) process.stdout.write(`  - ${k}\n`);
const extra = [...dict].filter((k) => !keys.includes(k));
process.stdout.write(`extra=${extra.length}\n`);
for (const k of extra) process.stdout.write(`  + ${k}\n`);
if (missing.length > 0) process.exit(1);
