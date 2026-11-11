import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ ЗВОНКОВ РОБОТА (П3, 11.11.2026).
 *
 * Звонок робота набирается только мостом живого голоса, и каждая функция набора моста
 * первой строкой спрашивает дверь `robotCallRefusal` (lib/robotCallPolicy.ts) — часы,
 * праздники, «не звонить», чёрный список, частоту. Новая функция набора без этой строки
 * или прямой набор в обход моста — красный тест, а не звонок клиенту в 23:00.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const BRIDGE = join(SRC, "lib/telephony/liveVoiceBridge.ts");
const ARI = join(SRC, "lib/telephony/ariClient.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Верхнеуровневые функции файла: имя, экспортирована ли, тело — от заголовка до
 * следующего верхнеуровневого объявления (функции, const, type, export…).
 */
function topLevelFunctions(source: string): Array<{ name: string; exported: boolean; body: string }> {
  const out: Array<{ name: string; exported: boolean; body: string }> = [];
  const head = /^(export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  const boundary = /^(?:export\s|async\s+function\s|function\s|const\s|let\s|var\s|interface\s|type\s|class\s|enum\s)/gm;
  for (const m of source.matchAll(head)) {
    boundary.lastIndex = m.index! + m[0].length;
    const next = boundary.exec(source);
    out.push({ name: m[2], exported: !!m[1], body: source.slice(m.index!, next ? next.index : source.length) });
  }
  return out;
}

function exportedFunctionBodies(source: string, namePattern: RegExp): Array<{ name: string; body: string }> {
  return topLevelFunctions(source).filter((f) => f.exported && namePattern.test(f.name));
}

/** Первый оператор тела функции (после закрывающей скобки сигнатуры и `{`). */
function firstStatement(body: string): string {
  // Сигнатура может занимать много строк и содержать `{` в типах параметров:
  // тело начинается после `): Promise<…> {` на конце строки.
  const open = body.search(/\)\s*:\s*Promise<[^\n]*>\s*\{\s*\n/);
  if (open < 0) return "";
  const afterBrace = body.slice(body.indexOf("{\n", open) + 2);
  const lines = afterBrace.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  return lines[0] ?? "";
}

describe("звонок робота — только через одну дверь", () => {
  const bridge = readFileSync(BRIDGE, "utf8");

  it("набор ARI в Stasis (originateToStasisApp) зовётся только из моста живого голоса", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== BRIDGE && f !== ARI)
      .filter((f) => /\boriginateToStasisApp\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("каждая экспортируемая функция набора моста первой строкой спрашивает дверь", () => {
    const fns = exportedFunctionBodies(bridge, /^originate/);
    // Защита от пустого прохода: если разбор сломается, тест не должен позеленеть.
    expect(fns.map((f) => f.name).sort()).toEqual(
      expect.arrayContaining(["originateLiveVoiceCallToClient", "originateLiveVoiceScenarioCall", "originateLiveVoiceTestCall"])
    );
    const missing = fns
      .filter((f) => !/^\{\s*const refusal = await robotCallRefusal\(\{.*\}\);\s*if \(refusal\) return refusal;\s*\}$/.test(firstStatement(f.body)))
      .map((f) => f.name);
    expect(missing).toEqual([]);
  });

  it("в мосте набор идёт только из функций, которые спрашивают дверь", () => {
    // Каждый вызов originateGuarded/originateToStasisApp лежит внутри одной из
    // проверенных выше экспортируемых функций набора — и после вызова двери.
    const fns = exportedFunctionBodies(bridge, /^originate/);
    const allExports = exportedFunctionBodies(bridge, /./);
    for (const f of allExports) {
      const dials = [...f.body.matchAll(/\boriginate(?:Guarded|ToStasisApp)\s*\(/g)].map((m) => m.index!);
      // Определения самих обёрток не экспортируются; вызов в любой другой экспортируемой функции — обход.
      if (dials.length === 0) continue;
      expect(fns.map((x) => x.name), `${f.name} набирает номер, не будучи функцией набора с дверью`).toContain(f.name);
      const door = f.body.indexOf("robotCallRefusal(");
      expect(door, f.name).toBeGreaterThan(-1);
      for (const at of dials) expect(door, f.name).toBeLessThan(at);
    }
  });

  it("неэкспортируемые функции моста не набирают номер сами (кроме обёртки originateGuarded)", () => {
    const offenders = topLevelFunctions(bridge)
      .filter((f) => !f.exported && f.name !== "originateGuarded")
      .filter((f) => /\boriginate(?:Guarded|ToStasisApp)\s*\(/.test(f.body))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("дверь `robotCallRefusal` и правда спрашивает `robotCallAllowed`", () => {
    const policy = readFileSync(join(SRC, "lib/robotCallPolicy.ts"), "utf8");
    const [refusal] = exportedFunctionBodies(policy, /^robotCallRefusal$/);
    expect(refusal?.body).toMatch(/await robotCallAllowed\(target\)/);
  });
});
