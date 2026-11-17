import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CI guard, one brain step 2 (owner 16.11.2026): the old customer bot (src/ai/leadQualifier.ts) has exactly ONE
 * production importer — the door src/ai/legacyQualifyDoor.ts. Every channel that still answers with the old bot goes
 * through the door, which carries the per-channel shadow switch. Step 3 deletes leadQualifier.ts; then this list is empty.
 *
 * Tests may still import the old module directly: they test it and are deleted together with it.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = new Set(["src/ai/legacyQualifyDoor.ts"]);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'][^"']*\/leadQualifier(?:\.js|\.ts)?["']/;
const QUALIFY_CALL = /\brunQualifyTurn\s*\(/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
/** Comment lines mention the old module in prose; only code counts. */
const codeLines = (text: string) => text.split(/\r?\n/).filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));
export function leadQualifierImporters(sources: ReadonlyArray<{ path: string; text: string }>): string[] {
  return sources.filter(source => !ALLOWED.has(source.path) && codeLines(source.text).some(line => IMPORT.test(line) ||
    QUALIFY_CALL.test(line) && !source.path.endsWith("ai/leadQualifier.ts"))).map(source => source.path).sort();
}

describe("one brain: the old customer bot has one door", () => {
  const sources = ["src", "scripts"].flatMap(dir => files(join(root, dir)))
    .map(path => ({ path: relative(root, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));

  it("no production file imports leadQualifier or calls runQualifyTurn except the door", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(leadQualifierImporters(sources)).toEqual([]);
  });

  it("the door itself still is the importer (step 3 replaces its body)", () => {
    const door = sources.find(source => source.path === "src/ai/legacyQualifyDoor.ts");
    expect(door && IMPORT.test(door.text)).toBe(true);
  });

  it("catches the breakage it exists for: a direct, dynamic or re-export import and a stray call", () => {
    expect(leadQualifierImporters([
      { path: "src/messengers/x.ts", text: 'import { runQualifyTurn } from "../ai/leadQualifier.js";' },
      { path: "src/jobs/y.ts", text: 'const m = await import("../ai/leadQualifier.js");' },
      { path: "src/lib/z.ts", text: 'export { mergeDraft } from "../ai/leadQualifier";' },
      { path: "src/lib/w.ts", text: "  const r = await runQualifyTurn(history, draft, options);" },
      { path: "src/lib/ok.ts", text: "// runQualifyTurn( was the old bot\n * see leadQualifier.ts" },
    ])).toEqual(["src/jobs/y.ts", "src/lib/w.ts", "src/lib/z.ts", "src/messengers/x.ts"]);
  });
});
