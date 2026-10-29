#!/usr/bin/env node
// Importer of the REAL anonymised corpus into attack-harness files. Real texts are read from --src and written ONLY to --out,
// which must be outside this repository: they never enter git (same rule as tests/replay). Conversion logic and its test live in
// apps/api/tests/attack/importReal.ts + import.test.ts.
//   node scripts/attack-import-real.mjs --src D:/CRM-migration-20261021/attack-corpus --out D:/attack-real-out
// Writes: real-scenarios.json, real-findings-rules.json, real-lessons-reference.json. Feed the folder to
//   node scripts/attack-customer-core.mjs --dataset <out>
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conversationsToScenarios, findingsToRules, lessonsToReference } from "../apps/api/tests/attack/importReal.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const take = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const fail = message => { console.error(message); process.exit(2); };

const src = take("--src"), out = take("--out");
if (!src || !out || !isAbsolute(src) || !isAbsolute(out)) fail("usage: node scripts/attack-import-real.mjs --src <abs folder with real-*.json> --out <abs folder OUTSIDE the repository>");
const repo = realpathSync(root);
let probe = resolve(out);
while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
const insideRepo = target => { const rel = relative(repo, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };
if (insideRepo(realpathSync(probe)) || insideRepo(resolve(out))) fail("--out must be outside the git repository: real customer texts never enter git");

const read = name => {
  const file = join(src, name);
  if (!existsSync(file)) return { missing: true, value: [] };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value)) fail(`${name}: expected a JSON array`);
  return { missing: false, value };
};
const conversations = read("real-conversations.json"), findings = read("real-findings.json"), lessons = read("real-lessons.json");
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 1), { mode: 0o600 });

const { scenarios, stats } = conversationsToScenarios(conversations.value);
write("real-scenarios.json", scenarios);
const rules = findingsToRules(findings.value);
write("real-findings-rules.json", rules);
const reference = lessonsToReference(lessons.value);
write("real-lessons-reference.json", reference);

console.log(JSON.stringify({
  out, missingInputs: [["real-conversations.json", conversations], ["real-findings.json", findings], ["real-lessons.json", lessons]].filter(([, item]) => item.missing).map(([name]) => name),
  scenarios: stats, findings: { total: rules.total, byType: Object.fromEntries(Object.entries(rules.byType).map(([type, item]) => [type, item.count])), unknownTypes: rules.unknownTypes, enableRules: rules.enableRules },
  lessons: reference.stats,
}, null, 2));
