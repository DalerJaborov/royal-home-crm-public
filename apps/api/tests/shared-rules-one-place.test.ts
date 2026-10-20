import { describe, expect, it } from "vitest";
import {
  DUSHANBE_OFFSET_MS,
  distanceMeters as sharedDistanceMeters,
  dushanbeDayKey as sharedDayKey,
  dushanbeHour as sharedHour,
  isDialableTajikNumber as sharedDialable,
  parseWktPolygonRing as sharedRing,
} from "@royal-home/shared";

import { distanceMeters, parseWktPolygonRing } from "../src/lib/geo.js";
import { dushanbeDayKey } from "../src/lib/aiDailyBudget.js";
import { isDialableTajikNumber } from "../src/lib/telephony/ariClient.js";
import { dushanbeHour } from "../src/lib/postStats.js";

/**
 * ОДНО ПРАВИЛО — ОДНО МЕСТО: ГЕОМЕТРИЯ, СУТКИ, НАБИРАЕМОСТЬ НОМЕРА.
 *
 * Все четыре правила ниже до 22.09.2026 были написаны ДВАЖДЫ — раз на сервере,
 * раз на сайте, — и три из четырёх файлов честно про это говорили в шапке
 * («зеркалит apps/api/src/lib/geo.ts», «та же проверка, что и на сервере»). То
 * есть расхождение видели, но общего дома у правила не было. Теперь есть,
 * `packages/shared`, и обе стороны зовут оттуда.
 *
 * Тест сторожит не арифметику (её сторожат тесты по месту применения), а
 * ГРАНИЦУ: серверные имена обязаны оставаться тонкими обёртками над общими.
 * Пока это так, разойтись двум сторонам не на чем. Покраснеет он ровно на
 * попытке вернуть на сервер своё вычисление — а комментарии в файлах по обе
 * стороны называют причину.
 *
 * Тестов фронта отсюда не видно; со стороны сайта ту же границу держит сторож
 * `npm run audit:rules` (scripts/audit-shared-rules.mjs), который не пропускает
 * имя, объявленное и там, и там без общего источника.
 *
 * Почему это не «и так одинаково, не трогай»: копия расходится не сразу, а с
 * первой правкой одной из сторон, и расходится МОЛЧА — каждая сторона остаётся
 * согласна сама с собой, поэтому ни сборка, ни тесты, ни карта этого не видят.
 * Живой случай, с которого начали, — `toTjs` (money-shared-rule.test.ts рядом).
 */
describe("общие правила зовутся из одного места", () => {
  it("расстояние на сервере считает общая функция", () => {
    // Пары взяты по Душанбе: центр, вокзал, аэропорт, и вырожденный случай.
    const pairs: [number, number, number, number][] = [
      [38.5598, 68.787, 38.5598, 68.787],
      [38.5598, 68.787, 38.5731, 68.7864],
      [38.5598, 68.787, 38.5433, 68.8248],
      [38.4, 68.6, 38.7, 68.95],
    ];
    for (const [a, b, c, d] of pairs) {
      expect(distanceMeters(a, b, c, d)).toBe(sharedDistanceMeters(a, b, c, d));
    }
    expect(distanceMeters(38.5598, 68.787, 38.5598, 68.787)).toBe(0);
  });

  it("порядок точек WKT — [долгота, широта], и он один на сервере и в общем пакете", () => {
    const wkt = "POLYGON((68.78 38.55, 68.79 38.55, 68.79 38.56, 68.78 38.55))";
    const ring = parseWktPolygonRing(wkt);
    expect(ring).toEqual(sharedRing(wkt));
    // Именно это перепутывают: первая координата — долгота (68.x), вторая — широта (38.x).
    expect(ring?.[0]).toEqual([68.78, 38.55]);
    expect(parseWktPolygonRing("не полигон")).toBeNull();
  });

  it("ключ суток по Душанбе считает общая функция, и граница стоит на 19:00 UTC", () => {
    expect(DUSHANBE_OFFSET_MS).toBe(5 * 60 * 60 * 1000);
    for (const iso of [
      "2026-09-22T18:59:59.999Z",
      "2026-09-22T19:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T19:00:00.000Z",
    ]) {
      const at = new Date(iso);
      expect(dushanbeDayKey(at)).toBe(sharedDayKey(at));
    }
    expect(dushanbeDayKey(new Date("2026-09-22T18:59:59.999Z"))).toBe("2026-09-22");
    expect(dushanbeDayKey(new Date("2026-09-22T19:00:00.000Z"))).toBe("2026-09-23");
  });

  it("набираемость номера решает общая функция — сервер и сайт отвечают одинаково", () => {
    const numbers = [
      "+992 90 000 00 01", // 12 цифр с кодом страны
      "992900000001",
      "0 90 000 00 01", // местная запись с нулём
      "900000001", // девять цифр
      "+7 999 123 45 67", // не таджикский
      "+992•••••57", // замаскированный номер, цифр мало
      "",
      "не номер",
    ];
    for (const n of numbers) {
      expect(isDialableTajikNumber(n)).toBe(sharedDialable(n));
    }
    expect(isDialableTajikNumber("+992 90 000 00 01")).toBe(true);
    expect(isDialableTajikNumber("900000001")).toBe(true);
    expect(isDialableTajikNumber("+7 999 123 45 67")).toBe(false);
    expect(isDialableTajikNumber("+992•••••57")).toBe(false);
  });

  it("dushanbeHour: статистика роликов зовёт общее правило, граница суток в 19:00 UTC (24.09.2026)", () => {
    for (let i = 0; i < 2000; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 4_321_987);
      expect(dushanbeHour(at)).toBe(sharedHour(at));
      expect(sharedHour(at)).toBe(new Date(at.getTime() + DUSHANBE_OFFSET_MS).getUTCHours());
    }
    expect(sharedHour(new Date("2026-09-24T18:59:59.999Z"))).toBe(23);
    expect(sharedHour(new Date("2026-09-24T19:00:00.000Z"))).toBe(0);
  });
});
