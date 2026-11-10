import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ: КАЖДАЯ ТАБЛИЦА С КАСКАДОМ НА СОТРУДНИКА РЕШЕНА В lib/agentHistory.ts
 * (07.11.2026, ревью пачки 2 Шабнам). Удаление сотрудника молча стирает строки таблиц с
 * `onDelete: Cascade` на Agent. `agentHasCascadeHistory` должен знать о каждой такой таблице
 * («история») или она должна быть явно названа «не историей» с причиной. Новая модель без
 * решения — красный тест. Проверено поломкой: убранная из списка AiAssistantTurnLog краснит.
 */

const { AGENT_CASCADE_HISTORY, AGENT_CASCADE_NOT_HISTORY } = await import("../src/lib/agentHistory.js");

/** Модели, у которых поле-связь на Agent удаляется каскадом (разбор текста схемы). */
function agentCascadeModels(schema: string): string[] {
  const models: string[] = [];
  const re = /^model (\w+) \{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  const text = schema.replace(/\r\n/g, "\n");
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  while ((m = re.exec(text))) {
    // Поле на несколько строк («@relation(\n fields: …,\n onDelete: Cascade\n)») склеиваем до закрытой скобки.
    const fields: string[] = [];
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      const last = fields[fields.length - 1];
      if (last !== undefined && count(last, "(") > count(last, ")")) fields[fields.length - 1] = `${last} ${line}`;
      else fields.push(line);
    }
    if (fields.some((l) => /^\w+\s+Agent\??\s+@relation\(/.test(l) && /onDelete:\s*Cascade/.test(l))) models.push(m[1]);
  }
  return models.sort();
}

describe("каскад на сотрудника — каждая таблица решена", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const cascade = agentCascadeModels(schema);

  it("разбор схемы видит известные таблицы (сам сторож не ослеп)", () => {
    expect(cascade).toContain("LoginLog");
    expect(cascade).toContain("AiAssistantTurnLog");
    expect(cascade.length).toBeGreaterThan(15);
  });

  it("каждая модель с каскадом — либо история, либо «не история» с причиной; лишних нет", () => {
    const decided = [...Object.keys(AGENT_CASCADE_HISTORY), ...Object.keys(AGENT_CASCADE_NOT_HISTORY)].sort();
    expect(cascade.filter((m) => !decided.includes(m))).toEqual([]);
    expect(decided.filter((m) => !cascade.includes(m))).toEqual([]);
    for (const reason of Object.values(AGENT_CASCADE_NOT_HISTORY)) expect(reason.trim().length).toBeGreaterThan(5);
  });

  it("история и «не история» не пересекаются", () => {
    const both = Object.keys(AGENT_CASCADE_HISTORY).filter((m) => m in AGENT_CASCADE_NOT_HISTORY);
    expect(both).toEqual([]);
  });

  it("многострочный @relation тоже виден (сам разбор не слепнет)", () => {
    const sample = "model Foo {\n  id String @id\n  agent Agent @relation(\n    fields: [agentId],\n    references: [id],\n    onDelete: Cascade\n  )\n}\n";
    expect(agentCascadeModels(sample)).toEqual(["Foo"]);
  });

  it("сторож краснеет на поломке: модель без решения находится", () => {
    const broken = { ...AGENT_CASCADE_HISTORY } as Record<string, unknown>;
    delete broken.AiAssistantTurnLog;
    const decided = [...Object.keys(broken), ...Object.keys(AGENT_CASCADE_NOT_HISTORY)];
    expect(cascade.filter((m) => !decided.includes(m))).toEqual(["AiAssistantTurnLog"]);
  });
});
