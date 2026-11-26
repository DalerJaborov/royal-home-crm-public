import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Клик-аудит 26.11.2026: кнопка «Назначить показ» в календаре на ПК вела в список клиентов без слова
 * об этом (на телефоне подпись «— выбрать клиента»). Своей формы показа у календаря нет, поэтому
 * каждая такая кнопка, ведущая на /clients, обязана говорить, куда ведёт.
 */
const src = readFileSync(join(__dirname, "..", "Calendar.tsx"), "utf8");

describe("календарь: «Назначить показ» говорит, куда ведёт", () => {
  it("все кнопки с переходом на /clients подписаны «— выбрать клиента»", () => {
    const parts = src.split('onClick={() => navigate("/clients")}').slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      const label = part.slice(0, part.indexOf("</button>"));
      expect(label).toContain("Назначить показ — выбрать клиента");
    }
  });
});
