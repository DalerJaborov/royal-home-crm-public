// Reproducible scope inventory. A test import or mapped route does not prove coverage.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const files = execFileSync("git", ["ls-files", "apps", "packages"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/);
const sources = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && /(?:\/src\/|\/prisma\/seed)/.test(f) && !/\/(__tests__|generated)\//.test(f) && !/\.test\./.test(f));
const tests = files.filter((f) => /(?:\.test\.|\.spec\.)[cm]?[jt]sx?$/.test(f));
const map = JSON.parse(read("docs/product-map.json"));
const owner = (file) => file.startsWith("apps/web/") ? "frontend_roles"
  : /^apps\/api\/src\/routes\/(?:expenses|finance|deals|clients|properties)/.test(file) ? "business_rules"
  : file.startsWith("apps/api/src/routes/") ? "api_roles" : "parent";
const layers = Object.fromEntries(["screens", "modules", "cron", "jobs", "external"].map((kind) => [kind,
  map[kind].map((item) => ({ ...item, reviewState: "pending", evidence: [] }))]));
const inventory = {
  baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  generatedAt: new Date().toISOString(),
  interpretation: "Pending means no individual evidence recorded by this inventory. Reading, direct imports and green suites are distinct from complete scenario coverage. Consult specialist reports for reviewed files and executed checks.",
  counts: { sourceFiles: sources.length, existingTestFiles: tests.length, ...Object.fromEntries(Object.entries(layers).map(([k,v])=>[k,v.length])) },
  layers,
  sourceFiles: sources.map((file) => ({ file, bytes: Buffer.byteLength(read(file)), owner: owner(file), reviewState: "pending", evidence: [] })),
  existingTestFiles: tests,
};
const out = path.join(root, "docs/audit-20261024");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
const table = Object.entries(inventory.counts).map(([k,v])=>`| ${k} | ${v} |`).join("\n");
fs.writeFileSync(path.join(out, "COVERAGE.md"), `# Audit scope and coverage\n\nBaseline: ${inventory.baseline}. Generated ${inventory.generatedAt}.\n\n| Inventory layer | Count |\n| --- | ---: |\n${table}\n\nThe machine inventory is inventory.json. Its pending states deliberately do not imply that an area is tested. Specialist reports record actual reviewed paths, reproductions and executed checks. A consolidated green suite does not prove all routes, roles or business scenarios.\n\n## Scenario matrix\n\n| Dimension | Required variants | Evidence status |\n| --- | --- | --- |\n| Identity and permissions | anonymous, agent, manager/admin, director, revoked rights, foreign ownership | assigned API/frontend review; runtime subset pending |\n| Inputs | omitted/null/empty/invalid/large text, Unicode, numbers, dates, arrays, files | assigned; runtime subset pending |\n| Business state | draft/planned/paid/archive/deleted, stale version, conflicting updates | isolated PG regression subset pending |\n| Transport | unavailable network, response lost after commit, timeout, duplicate submit | frontend regression subset pending |\n| UI | desktop and 390px, loading/empty/error/permission, cancel and pending submit | component/browser subset pending |\n| Async | race/lock order, retries, provider unknown outcome, scheduled status changes | API race tests and parent source review pending |\n| Integration | real PG, local browser, provider contract mocks | no live provider delivery or production mutations |\n\n## Explicit limits\n\nProduction behavior, physical iOS/Android, external provider delivery, exhaustive role combinations, every scheduler and every source file are unverified until named evidence exists.\n`);
console.log(JSON.stringify(inventory.counts));
