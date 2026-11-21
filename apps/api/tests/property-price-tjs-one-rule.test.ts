import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import { narrationPriceWords, propertyPriceTjs, tajikCardinal } from "@royal-home/shared";
import { propertyPriceTjsText } from "../src/lib/reelsCaptionTemplate.js";
import { buildCoverPosterValues, CoverPriceUnavailable } from "../src/lib/video/coverPoster.js";

/**
 * ЦЕНА В СОМОНИ — ОДНО ЧИСЛО (ревью #348, 21.11.2026). Было три правила: голос округлял до тысячи, монтажёр
 * получал точную сумму, обложка брала запасной курс. Теперь все зовут `propertyPriceTjs` (packages/shared),
 * и тест сверяет: голос, текст монтажёру и плашке, обложка — одно число; нет курса — нет цены нигде.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const flat = { rooms: 2, areaSqm: "106", floor: 21, districtName: "Сино", address: "улица Айни 12" };

describe("цена в сомони: голос, монтажёр, плашка и обложка говорят одно число", () => {
  it("доллары по курсу до тысячи; сомони как есть", () => {
    expect(propertyPriceTjs("127200", "USD", 9.27)).toBe(1_179_000);
    expect(propertyPriceTjs("850000", "TJS", null)).toBe(850_000);
    expect(propertyPriceTjs("0", "TJS", 9.27)).toBeNull();
  });

  it("одно и то же число в трёх местах", () => {
    const n = propertyPriceTjs("127200", "USD", 9.27)!;
    const voice = narrationPriceWords({ type: "APARTMENT", rooms: 2, areaSqm: "106", floor: 21, totalFloors: 24, district: "Сино", price: "127200", currency: "USD", usdToTjs: 9.27 }, "tg");
    expect(voice).toBe(`${tajikCardinal(n)} сомонӣ`);
    const text = propertyPriceTjsText("127200", "USD", 9.27)!;
    expect(text.replace(/\D/g, "")).toBe(String(n));
    const cover = buildCoverPosterValues({ ...flat, price: "127200", currency: "USD" }, { usdToTjs: 9.27 });
    expect(cover.priceNumber.replace(/\D/g, "")).toBe(String(n));
  });

  it("нет курса — цены нет нигде: голос молчит о цене, монтажёру и на плашку null, обложка отказывает", () => {
    expect(narrationPriceWords({ type: "APARTMENT", rooms: 2, areaSqm: "106", floor: 21, totalFloors: 24, district: "Сино", price: "127200", currency: "USD" }, "tg")).toBe("");
    expect(propertyPriceTjsText("127200", "USD", null)).toBeNull();
    expect(() => buildCoverPosterValues({ ...flat, price: "127200", currency: "USD" }, { usdToTjs: null })).toThrow(CoverPriceUnavailable);
  });

  it("сторож: в местах цены монтажёру, на плашке и обложке нет запасного курса и своего пересчёта", () => {
    for (const file of ["lib/videoHandoff.ts", "lib/narrationAutoFlow.ts", "lib/video/coverPoster.ts", "lib/video/coverOpenAi.ts"]) {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(source, file).not.toMatch(/\bpriceInTjsOnly\(|\bpriceTjsAmount\(|\btoTjs\(/);
    }
    for (const file of ["lib/narrationAutoFlow.ts", "lib/video/coverPoster.ts", "lib/video/coverOpenAi.ts"]) {
      expect(fs.readFileSync(path.join(SRC, file), "utf8"), file).not.toMatch(/\bloadMoneyContext\(/);
    }
  });
});
