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
function topLevelFunctions(source: string): Array<{ name: string; exported: boolean; body: string; start: number; end: number }> {
  const out: Array<{ name: string; exported: boolean; body: string; start: number; end: number }> = [];
  const head = /^(export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  const boundary = /^(?:export\s|async\s+function\s|function\s|const\s|let\s|var\s|interface\s|type\s|class\s|enum\s)/gm;
  for (const m of source.matchAll(head)) {
    boundary.lastIndex = m.index! + m[0].length;
    const next = boundary.exec(source);
    const end = next ? next.index : source.length;
    out.push({ name: m[2], exported: !!m[1], body: source.slice(m.index!, end), start: m.index!, end });
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

  it("в мосте КАЖДЫЙ набор лежит внутри функции набора с дверью, и после неё", () => {
    // Ловит и `export const originateX = async () => …`, и набор из неэкспортируемого
    // помощника, и набор из кода вне функций: всё это вне проверенных функций.
    const fns = topLevelFunctions(bridge);
    const guarded = fns.filter((f) => f.exported && /^originate/.test(f.name));
    const wrapper = fns.find((f) => f.name === "originateGuarded");
    const offenders: string[] = [];
    for (const m of bridge.matchAll(/\boriginate(?:Guarded|ToStasisApp)\s*\(/g)) {
      const at = m.index!;
      if (wrapper && at >= wrapper.start && at < wrapper.end) continue; // сама обёртка
      if (/^import|^\s*\.\.\.args: Parameters<typeof/.test(bridge.slice(bridge.lastIndexOf("\n", at) + 1, at + 40))) continue;
      const owner = guarded.find((f) => at >= f.start && at < f.end);
      const line = bridge.slice(0, at).split("\n").length;
      if (!owner) offenders.push(`строка ${line}: набор вне функции набора с дверью`);
      else if (owner.body.indexOf("robotCallRefusal(") < 0 || owner.start + owner.body.indexOf("robotCallRefusal(") > at) {
        offenders.push(`строка ${line}: набор в ${owner.name} раньше двери`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("функций набора стрелками (export const originate… = async) в мосте нет", () => {
    expect(bridge.match(/^export\s+(?:const|let|var)\s+originate\w*\s*=/gm) ?? []).toEqual([]);
  });

  it("запросы к каналам ARI (`/ari/channels`) — только в ariClient.ts (там же и звонок агента originateCall)", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== ARI)
      // Запрос, а не упоминание в комментарии: fetch( или адрес в переменной с /ari/channels.
      .filter((f) => /fetch\(\s*[`'"][^`'"]*\/ari\/channels|=\s*[`'"][^`'"\n]*\/ari\/channels/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("дверь `robotCallRefusal` и правда спрашивает `robotCallAllowed`", () => {
    const policy = readFileSync(join(SRC, "lib/robotCallPolicy.ts"), "utf8");
    const [refusal] = exportedFunctionBodies(policy, /^robotCallRefusal$/);
    expect(refusal?.body).toMatch(/await robotCallAllowed\(target\)/);
  });
});
