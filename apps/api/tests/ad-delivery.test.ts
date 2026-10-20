import { describe, expect, it } from "vitest";
import { adDelivery } from "../src/lib/ads/adDelivery.js";
import { centsToTjs, fromCents, toCents } from "../src/lib/money.js";

/**
 * «ИДЁТ ЛИ РЕКЛАМА» И «СХОДЯТСЯ ЛИ ДЕНЬГИ» — два вопроса, из-за которых раздел
 * переписывали 03.09.2026.
 *
 * Первый: Meta присылает effective_status=ACTIVE и у давно закончившихся
 * объявлений — на живых данных агентства такими были 33 из 41 при шести реально
 * тративших. Второй: суммы складывались числами с плавающей точкой, и колонка не
 * сходилась с итогом под ней.
 *
 * Чистые функции, без базы: обе — правила, а не запросы.
 */

const asOf = new Date("2026-09-03T12:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("Состояние объявления считается по факту трат, а не по статусу Meta", () => {
  it("ACTIVE + трата сегодня = идёт", () => {
    expect(adDelivery({ status: "ACTIVE", stopTime: null, lastSpendAt: day("2026-09-03"), asOf })).toBe("RUNNING");
  });

  it("ACTIVE + трата вчера = ещё идёт: Meta досчитывает вчерашний день", () => {
    expect(adDelivery({ status: "ACTIVE", stopTime: null, lastSpendAt: day("2026-09-02"), asOf })).toBe("RUNNING");
  });

  it("ACTIVE + срок показа вышел весной = завершено, а не «идёт»", () => {
    // Ровно случай владельца: в кабинете статус ACTIVE, последняя трата в мае.
    expect(
      adDelivery({ status: "ACTIVE", stopTime: day("2026-05-10"), lastSpendAt: day("2026-05-14"), asOf })
    ).toBe("FINISHED");
  });

  it("ACTIVE, срок открыт, но трат неделю = «не тратит», а не «идёт»", () => {
    expect(adDelivery({ status: "ACTIVE", stopTime: null, lastSpendAt: day("2026-08-25"), asOf })).toBe("STALLED");
  });

  it("ACTIVE и ни одной траты за всю жизнь = «без трат»", () => {
    expect(adDelivery({ status: "ACTIVE", stopTime: null, lastSpendAt: null, asOf })).toBe("NEVER");
  });

  it("трата сегодня сильнее просроченного срока: в кабинете его продлили", () => {
    expect(
      adDelivery({ status: "ACTIVE", stopTime: day("2026-08-25"), lastSpendAt: day("2026-09-03"), asOf })
    ).toBe("RUNNING");
  });

  it("выключенное руками остаётся выключенным, даже если деньги ушли сегодня", () => {
    for (const status of ["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"]) {
      expect(adDelivery({ status, stopTime: null, lastSpendAt: day("2026-09-03"), asOf })).toBe("PAUSED");
    }
  });

  it("отклонённое модерацией не «идёт», даже если утром успело потратить", () => {
    expect(adDelivery({ status: "DISAPPROVED", stopTime: null, lastSpendAt: day("2026-09-03"), asOf })).toBe(
      "REJECTED"
    );
  });

  it("модерация и отказ Meta названы своими словами", () => {
    expect(adDelivery({ status: "DISAPPROVED", stopTime: null, lastSpendAt: null, asOf })).toBe("REJECTED");
    expect(adDelivery({ status: "PENDING_REVIEW", stopTime: null, lastSpendAt: null, asOf })).toBe("REVIEW");
  });

  it("судим на момент последней сверки: оборванная синхронизация не «выключает» рекламу", () => {
    // Сверка встала 30 августа; последняя известная трата — того же дня. Пока мы
    // не знаем нового, объявление считается идущим, а не остановленным.
    const staleAsOf = new Date("2026-08-30T10:00:00.000Z");
    expect(
      adDelivery({ status: "ACTIVE", stopTime: null, lastSpendAt: day("2026-08-30"), asOf: staleAsOf })
    ).toBe("RUNNING");
  });
});

describe("Деньги складываются целыми сотыми — колонка сходится с итогом", () => {
  it("классический промах плавающей точки не доезжает до отчёта", () => {
    // 0.1 + 0.2 !== 0.3 в двоичной арифметике; в сотых — ровно 30.
    expect(toCents(0.1) + toCents(0.2)).toBe(30);
    expect(fromCents(toCents(0.1) + toCents(0.2))).toBe(0.3);
  });

  it("сумма показанных строк равна показанному итогу до дирама", () => {
    const rate = { usdToTjs: 11.27 };
    // Дневные траты кабинета в долларах — типичные, с копейками.
    const days = [0.83, 1.17, 2.05, 0.99, 3.33, 0.07, 1.5];
    const rows = days.map((d) => centsToTjs(toCents(d), "USD", rate));
    const total = rows.reduce((acc, c) => acc + c, 0);

    // Итог считается из тех же чисел, что показаны строками: расхождению взяться
    // неоткуда, каким бы ни был курс.
    expect(fromCents(total)).toBe(Number(rows.reduce((acc, c) => acc + fromCents(c) * 100, 0).toFixed(0)) / 100);
    expect(Number.isInteger(total)).toBe(true);
  });

  it("сомони не пересчитываются: курс к ним не применяется", () => {
    expect(centsToTjs(12345, "TJS", { usdToTjs: 11 })).toBe(12345);
  });

  it("мусор вместо суммы даёт ноль, а не NaN в отчёте", () => {
    expect(toCents(undefined)).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents("не число")).toBe(0);
  });
});
