import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Текстовые сторожа файла диалплана станции (ops/asterisk/extensions_custom.conf).
 * Станция в тестах не поднимается — проверяем, что правки аудита 03.10.2026 на месте
 * и их не унесёт следующая правка файла.
 */
const conf = readFileSync(resolve(__dirname, "../../../ops/asterisk/extensions_custom.conf"), "utf8").replace(/\r\n/g, "\n");
const inbound = conf.slice(conf.indexOf("[royalhome-inbound]"), conf.indexOf("[royalhome-agent-route]"));
const route = conf.slice(conf.indexOf("[royalhome-agent-route]"), conf.indexOf("[royalhome-agent-wait]"));

/**
 * Строки диалплана, которые станция выполнит, войдя в метку `label` секции: подряд,
 * с переходом по безусловному Goto(метка), до первого Hangup(). Комментарии и пустые
 * строки пропускаются. Условные переходы (GotoIf) не раскрываются — тест, которому
 * важно их отсутствие, проверяет это сам.
 */
function walkBranch(section: string, label: string): string[] {
  const lines = section.split("\n").filter((l) => /^\s*(exten|same)\s*=>/.test(l));
  const at = (name: string) => lines.findIndex((l) => l.includes(`n(${name}),`));
  let i = at(label);
  if (i < 0) throw new Error(`метка ${label} не найдена`);
  const out: string[] = [];
  for (let hops = 0; i >= 0 && i < lines.length && hops < 200; hops += 1) {
    const line = lines[i];
    out.push(line);
    if (line.includes("Hangup()")) break;
    const jump = /[,(]Goto\((\w+)\)\s*$/.exec(line);
    i = jump ? at(jump[1]) : i + 1;
  }
  return out;
}

describe("extensions_custom.conf", () => {
  it("офисный аппарат перед очередью — в репозитории, до Queue", () => {
    expect(inbound).toContain("ROYALHOME/office_first/ext");
    expect(inbound.indexOf("office_first/ext")).toBeLessThan(inbound.indexOf("Queue(1000,tr,,,"));
    expect(inbound).toContain("(queuego)");
  });

  it("запись не дублируется: каждый MixMonitor под проверкой REC_STATUS", () => {
    const lines = conf
      .split("\n")
      .filter((l) => l.startsWith("exten =>") && l.includes("MixMonitor("));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('"${REC_STATUS}"');
  });

  it("запасная очередь агентского пути ставит NODEST перед Queue", () => {
    const i = route.indexOf(" same => n,Queue(1000,tr)");
    expect(route.slice(0, i).trimEnd().endsWith("Set(__NODEST=1000)")).toBe(true);
  });

  it("имя файла автоответчика: только цифры, пусто — unknown, в обоих контекстах", () => {
    expect(conf).not.toMatch(/vm-\$\{STRFTIME[^\n]*-\$\{CALLERID\(num\)\}/);
    expect(conf.match(/FILTER\(0123456789,\$\{CALLERID\(num\)\}\)/g)).toHaveLength(2);
    expect(conf.match(/Set\(RH_VMNUM=unknown\)/g)).toHaveLength(2);
  });

  /**
   * КЛИЕНТ АГЕНТА РОБОТУ НЕ ДОСТАЁТСЯ (владелец 11.10.2026: «робот НЕ отвечает
   * клиентам агента — даже если агент не отвечает, он сам перезвонит»). Заменяет тест
   * 03.10 «known_client идёт к консультанту с аргументом known». Ветку проходим так,
   * как её пройдёт станция: строка за строкой, по безусловным Goto, до Hangup().
   */
  it("ветки knownclient и agent-route.voicemail доходят до автоответчика без Stasis", () => {
    const knownBranch = walkBranch(inbound, "knownclient");
    const vmBranch = walkBranch(route, "voicemail");
    for (const branch of [knownBranch, vmBranch]) {
      expect(branch.some((l) => l.includes("Record("))).toBe(true);
      expect(branch.filter((l) => /Stasis\(|GotoIf\(/.test(l))).toEqual([]);
    }
    expect(inbound).toContain('"known_client"]?knownclient');
    // Аргументов «known»/«missed» станция консультанту больше не шлёт вовсе.
    expect(conf).not.toMatch(/royalhome-live-voice,(known|missed)\)/);
    expect(conf).not.toContain("RH_AIARG=known");
    expect(conf).not.toContain("RH_AIARG=missed");
  });

  it("возврат к консультанту остался только у его собственного перевода (RH_ROUTE_FALLBACK=ai)", () => {
    expect(route).toContain('"${RH_ROUTE_FALLBACK}" = "ai"]?ai)');
    expect(walkBranch(route, "ai").some((l) => l.includes("Stasis(royalhome-live-voice,returned)"))).toBe(true);
  });

  it("у агентского автоответчика после приветствия тот же сигнал, что у входящего", () => {
    expect(route.match(/Playback\(beep\)\)\n same => n,Record/g)).toHaveLength(1);
  });
});
