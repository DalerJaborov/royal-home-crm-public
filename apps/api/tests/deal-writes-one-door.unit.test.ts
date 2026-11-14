import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ «ОДНА ДВЕРЬ» ДЛЯ ЗАПИСИ СДЕЛКИ (10.11.2026).
 *
 * Создание, смена этапа, закрытие, переоценка, выплата и аннулирование сделки
 * живут в lib/dealWrites.ts (+ lib/dealAnnul.ts). Роуты «Сделок» и ИИ-помощница
 * только зовут их. Если кто-то снова напишет `prisma.deal.update` прямо в роуте
 * или в инструменте помощницы, правило «закрытие = снапшот долей + баллы + сайт»
 * разъедется на две копии, и вторую никто не починит. Этот тест не пускает.
 */

const SRC = path.resolve(import.meta.dirname, "../src");
const FORBIDDEN = /\b(?:prisma|tx)\.deal\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\bsetDealPayout\(|\bannulDeal\(/u;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const guarded = [
  path.join(SRC, "routes/deals.ts"),
  path.join(SRC, "routes/dealPayout.ts"),
  path.join(SRC, "routes/dealAnnul.ts"),
  ...files(path.join(SRC, "ai/assistant")),
];

describe("запись сделки — только через lib/dealWrites.ts", () => {
  it.each(guarded.map((f) => [path.relative(SRC, f), f]))("%s не пишет сделку сам", (_name, file) => {
    const offenders = readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && FORBIDDEN.test(line));
    expect(offenders).toEqual([]);
  });

  it("сторож ловит прямую запись (проверка самого сторожа)", () => {
    expect(FORBIDDEN.test("await prisma.deal.updateMany({ where })")).toBe(true);
    expect(FORBIDDEN.test("await tx.deal.create({ data })")).toBe(true);
    expect(FORBIDDEN.test("await setDealPayout(id, me, null)")).toBe(true);
    expect(FORBIDDEN.test("await prisma.deal.findMany({})")).toBe(false);
  });

  it("роуты зовут общую дверь", () => {
    expect(readFileSync(path.join(SRC, "routes/deals.ts"), "utf8")).toMatch(/createDealFor\(req[\s\S]*updateDealFor\(req/u);
    expect(readFileSync(path.join(SRC, "routes/dealPayout.ts"), "utf8")).toContain("markDealPayoutFor(req");
    expect(readFileSync(path.join(SRC, "routes/dealAnnul.ts"), "utf8")).toContain("annulDealFor(req");
  });
});
