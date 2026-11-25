import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  COMMISSION_COMPANY_PERCENT,
  COMMISSION_REALTOR_PERCENT,
  COMMISSION_TOTAL_PERCENT,
} from "@royal-home/shared";

/**
 * ДОЛИ КОМИССИИ — ОДНО МЕСТО (владелец 25.11.2026): клиент платит 2%, 1% берёт
 * компания, 1% целиком агент; «приёма объекта» 0,5% нет.
 *
 * До этого проценты читались из строки Настроек (по умолчанию 0,5 / 1 / 0,5), а
 * доля интейка прибавлялась к компании: деление при закрытии выходило 25/75 (на
 * проде 40/60), «потенциальная комиссия» — 1,5% вместо 1%, оценка новой сделки —
 * 2,5%. Сторож ниже не даёт вернуть чтение этих полей в расчёты: колонки в БД
 * остаются только как история.
 */
describe("доли комиссии зашиты в shared", () => {
  it("1% агенту + 1% компании = 2%", () => {
    expect(COMMISSION_REALTOR_PERCENT).toBe(1);
    expect(COMMISSION_COMPANY_PERCENT).toBe(1);
    expect(COMMISSION_TOTAL_PERCENT).toBe(2);
  });

  it("ни один файл сервера не читает проценты комиссии из Настроек", () => {
    const root = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "generated") walk(p);
        } else if (e.name.endsWith(".ts")) {
          // Комментарии не считаем: история в них объяснена словами.
          const code = fs
            .readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          if (/commission(Intake|Realtor|Company)Percent/.test(code)) offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
