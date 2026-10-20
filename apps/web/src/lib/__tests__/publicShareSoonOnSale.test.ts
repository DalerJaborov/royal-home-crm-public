import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D16 (глубокая проверка 02.10.2026), решение владельца: публичная ссылка на
 * объект, который ещё готовится (проверка, фото, видео, монтаж), показывает
 * клиенту «Скоро в продаже», а не «В продаже». Сервер отдаёт saleStatus
 * "SOON" (routes/propertyShare.ts::shareSaleStatus), страница его подписывает.
 */
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../pages/PublicPropertyShare.tsx");

describe("Публичная ссылка: «Скоро в продаже»", () => {
  const text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
  it("у статуса SOON своя подпись", () => {
    expect(text).toMatch(/SOON: \{ label: "Скоро в продаже"/);
  });
  it("«скоро» — не «недоступен»: кнопка остаётся «Позвонить агенту»", () => {
    expect(text).toMatch(/const offMarket = sale !== "AVAILABLE" && sale !== "SOON";/);
  });
});
