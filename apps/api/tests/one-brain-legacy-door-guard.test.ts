import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI guard, one brain step 3b (owner 16.11.2026: «старый бот удалить полностью»): the old customer bot is gone and must not
 * come back. No file — production, scripts or tests — may import `leadQualifier` or the step-2 door `legacyQualifyDoor`, or
 * call `runQualifyTurn`; both files must not exist. Every channel body that used to ask the old bot asks the one door
 * `ai/customerChannelTurn.ts` (core channel adapter, or a person when the channel's core switch is off).
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)["'][^"']*\/(?:leadQualifier|legacyQualifyDoor)(?:\.js|\.ts)?["']/;
const QUALIFY_CALL = /\brunQualifyTurn\s*\(/;
const SELF = "tests/one-brain-legacy-door-guard.test.ts";

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}
/** Comment lines mention the old module in prose; only code counts. */
const codeLines = (text: string) => text.split(/\r?\n/).filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));
export function oldBotReferences(sources: ReadonlyArray<{ path: string; text: string }>): string[] {
  return sources.filter(source => source.path !== SELF && codeLines(source.text).some(line => IMPORT.test(line) || QUALIFY_CALL.test(line)))
    .map(source => source.path).sort();
}

describe("one brain: the old customer bot is deleted and stays deleted", () => {
  const sources = ["src", "scripts", "tests"].flatMap(dir => files(join(root, dir)))
    .map(path => ({ path: relative(root, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));

  it("the old bot and its step-2 door do not exist", () => {
    expect(existsSync(join(root, "src/ai/leadQualifier.ts"))).toBe(false);
    expect(existsSync(join(root, "src/ai/legacyQualifyDoor.ts"))).toBe(false);
  });

  it("no file imports, mocks or calls the old bot", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(oldBotReferences(sources)).toEqual([]);
  });

  it("every former caller asks the one door", () => {
    for (const path of ["src/messengers/conversation.ts", "src/telegram/bot.ts", "src/jobs/telegramReplyRetry.ts", "src/messengers/customerQualifierTurn.ts"]) {
      expect(sources.find(source => source.path === path)?.text, path).toContain("runCustomerChannelTurn(");
    }
  });

  it("catches the breakage it exists for: a direct, dynamic, re-export, mock import and a stray call", () => {
    expect(oldBotReferences([
      { path: "src/messengers/x.ts", text: 'import { runQualifyTurn } from "../ai/leadQualifier.js";' },
      { path: "src/jobs/y.ts", text: 'const m = await import("../ai/leadQualifier.js");' },
      { path: "src/lib/z.ts", text: 'export { mergeDraft } from "../ai/legacyQualifyDoor";' },
      { path: "tests/m.test.ts", text: 'vi.mock("../src/ai/leadQualifier.js", () => ({}));' },
      { path: "src/lib/w.ts", text: "  const r = await runQualifyTurn(history, draft, options);" },
      { path: "src/lib/ok.ts", text: "// runQualifyTurn( was the old bot\n * see leadQualifier.ts" },
    ])).toEqual(["src/jobs/y.ts", "src/lib/w.ts", "src/lib/z.ts", "src/messengers/x.ts", "tests/m.test.ts"]);
  });
});
