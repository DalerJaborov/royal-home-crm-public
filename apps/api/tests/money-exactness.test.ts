import { describe, expect, it } from "vitest";
import { centsToTjs, fromCents, roundMoney, splitCents, sumCents, toCents, toTjs } from "../src/lib/money.js";

/**
 * ДЕНЬГИ ДО КОПЕЙКИ — правила, на которых держится вся денежная часть CRM
 * (решение владельца 03.09.2026: «чтобы вообще не было ошибок по поводу денег,
 * даже до цента, супер строгий бухгалтер»).
 *
 * Проверяется не «функция что-то возвращает», а три обещания, которые до этого
 * нарушались в проде:
 *   1) сумма долей РАВНА базе — всегда, при любых процентах;
 *   2) пересчёт валюты даёт ровно два знака и один и тот же результат везде;
 *   3) итог, собранный сложением, не тащит двоичный хвост в отчёт и в базу.
 */

const rate = { usdToTjs: 11.27 };

describe("Деление суммы на доли не теряет и не рождает копейки", () => {
  it("три доли по процентам агентства складываются ровно в комиссию", () => {
    // 8 000,50 с. на 0,5 / 0,5 / 1 (проценты из Настроек по умолчанию).
    const base = toCents(8000.5);
    const parts = splitCents(base, [0.5, 0.5, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(base);
    expect(parts.map(fromCents)).toEqual([2000.13, 2000.12, 4000.25]);
  });

  it("сумма долей равна базе на тысяче случайных сумм и процентов", () => {
    let worst = 0;
    for (let i = 0; i < 1000; i++) {
      const base = Math.round(Math.random() * 5_000_000);
      const weights = [Math.random() * 5, Math.random() * 5, Math.random() * 5];
      const parts = splitCents(base, weights);
      const diff = Math.abs(parts.reduce((a, b) => a + b, 0) - base);
      worst = Math.max(worst, diff);
    }
    expect(worst).toBe(0);
  });

  it("доля с нулевым весом получает ноль, а её деньги не исчезают", () => {
    const base = toCents(1000);
    const [intake, realtor, company] = splitCents(base, [0, 1, 1]);
    expect(intake).toBe(0);
    expect(intake + realtor + company).toBe(base);
  });

  it("нулевая база и нулевые веса не роняют расчёт", () => {
    expect(splitCents(0, [1, 2])).toEqual([0, 0]);
    expect(splitCents(1000, [0, 0])).toEqual([0, 0]);
  });

  it("остаток достаётся доле с большим хвостом, а не первой попавшейся", () => {
    // 100 копеек на 1/3: 33,33 + 33,33 + 33,34 — лишняя копейка ровно одна.
    const parts = splitCents(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts.filter((p) => p === 34)).toHaveLength(1);
  });
});

describe("Пересчёт валюты округляется ровно один раз и ровно до копейки", () => {
  it("доллары превращаются в сомони без двоичного хвоста", () => {
    // 9.53 * 11.27 = 107.40310000000001 в двоичной арифметике.
    expect(toTjs(9.53, "USD", rate)).toBe(107.4);
    expect(centsToTjs(toCents(9.53), "USD", rate)).toBe(10740);
  });

  it("сомони не трогаются курсом, но всё равно чистятся до копейки", () => {
    expect(toTjs(1999.999, "TJS", rate)).toBe(2000);
    expect(toTjs(1999.994, "TJS", rate)).toBe(1999.99);
  });

  it("одна и та же сумма даёт один и тот же результат в любом месте CRM", () => {
    const a = toTjs(123.45, "USD", rate);
    const b = fromCents(centsToTjs(toCents(123.45), "USD", rate));
    expect(a).toBe(b);
  });

  it("мусор и пустота дают ноль, а не NaN в отчёте", () => {
    expect(toTjs(null, "USD", rate)).toBe(0);
    expect(toTjs("что-то", "TJS", rate)).toBe(0);
    expect(sumCents([null, undefined, "x", 1.5])).toBe(150);
  });
});

describe("Итог не тащит двоичный хвост", () => {
  it("сложение сотни сумм с копейками даёт ровно ожидаемое число", () => {
    const values = Array.from({ length: 100 }, () => 0.1);
    const naive = values.reduce((a, b) => a + b, 0);
    expect(naive).not.toBe(10); // 9.99999999999998 — вот с этим и жили
    expect(roundMoney(naive)).toBe(10);
    expect(fromCents(sumCents(values))).toBe(10);
  });

  it("roundMoney не портит уже точные суммы", () => {
    expect(roundMoney(1234.56)).toBe(1234.56);
    expect(roundMoney(0)).toBe(0);
    expect(roundMoney(Number.NaN)).toBe(0);
  });
});
