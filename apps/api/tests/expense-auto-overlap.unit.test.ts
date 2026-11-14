import { describe, expect, it } from "vitest";
import { autoExpenseOverlapText, findAutoExpenseOverlap, manualExpenseAutoKinds } from "@royal-home/shared";
import { adChannelOf } from "../src/ai/assistant/expenseArticles.js";

/**
 * Расход, который CRM считает сама, руками второй раз не вносится (14.11.2026).
 * Случай с прода: фото таблицы «октябрь» у директора, строка «ТАРГЕТ (инстаграм-фейсбук) 7278»,
 * а реклама Meta за октябрь уже стояла автоматической строкой 905,92 $ (курс CRM 9,24).
 */

const RATE = 9.24;
const metaOctober = { autoKey: "ads:META:2026-10", category: "ADVERTISING", amount: 905.92, currency: "USD", exchangeRate: null, agentId: null };
const aiOctober = { autoKey: "ai:2026-10", category: "OTHER", amount: 44.98, currency: "USD", exchangeRate: null, agentId: null };
const salary = { autoKey: "salary:agent-1:2026-10", category: "SALARY", amount: 12000, currency: "TJS", exchangeRate: null, agentId: "agent-1" };
const rent = { autoKey: "rec:tpl-1:2026-10", category: "OFFICE", amount: 5000, currency: "TJS", exchangeRate: 1, agentId: null };
const autos = [metaOctober, aiOctober, salary, rent];

describe("правило «уже учтено автоматически»", () => {
  it("случай 11.11: «ТАРГЕТ (инстаграм-фейсбук)» 7278 с. в «Прочем» — это реклама Meta октября", () => {
    const overlap = findAutoExpenseOverlap({ category: "OTHER", note: "ТАРГЕТ (инстаграм-фейсбук)", amount: 7278, currency: "TJS" }, autos, RATE);
    expect(overlap).toMatchObject({ kind: "ads_meta", autoKey: "ads:META:2026-10", autoAmountTjs: 8370.7, manualAmountTjs: 7278, amountClose: false });
    const text = autoExpenseOverlapText(overlap!, "2026-10");
    expect(text).toContain("905,92 $");
    expect(text).toContain("8 370,7 с.");
    expect(text).toContain("октябрь 2026");
    expect(text).not.toContain("—");
  });

  it("реклама с каналом Instagram/Facebook — тоже Meta; реклама у блогера в TikTok — нет", () => {
    expect(findAutoExpenseOverlap({ category: "ADVERTISING", source: "INSTAGRAM", note: "Продвижение", amount: 100, currency: "USD" }, autos, RATE)?.kind).toBe("ads_meta");
    expect(findAutoExpenseOverlap({ category: "ADVERTISING", source: "FACEBOOK", note: "x", amount: 3000, currency: "TJS" }, autos, RATE)?.kind).toBe("ads_meta");
    expect(findAutoExpenseOverlap({ category: "ADVERTISING", source: "TIKTOK", note: "Реклама у блогера", amount: 3000, currency: "TJS" }, autos, RATE)).toBeNull();
  });

  it("«ОПЛАТА ИИ» — расход на ИИ, с подсказкой про подписки; слова с «ии» внутри не считаются", () => {
    const overlap = findAutoExpenseOverlap({ category: "OTHER", note: "ОПЛАТА ИИ", amount: 2000, currency: "TJS" }, autos, RATE);
    expect(overlap?.kind).toBe("ai");
    expect(autoExpenseOverlapText(overlap!, "2026-10")).toContain("подписка");
    for (const note of ["Комиссии банка", "Канцтовары для бухгалтерии", "Вода для кулера"]) {
      expect(manualExpenseAutoKinds({ category: "OTHER", note, amount: 100 })).toEqual([]);
    }
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Подписка ChatGPT", amount: 20, currency: "USD" }, autos, RATE)?.kind).toBe("ai");
  });

  it("доля по сделкам: тот же сотрудник — пересечение, другой — нет", () => {
    expect(findAutoExpenseOverlap({ category: "SALARY", agentId: "agent-1", note: "Процент за сделку", amount: 3000, currency: "TJS" }, autos, RATE)?.kind).toBe("deal_salary");
    expect(findAutoExpenseOverlap({ category: "SALARY", agentId: "agent-2", note: "Зарплата", amount: 12000, currency: "TJS" }, autos, RATE)).toBeNull();
  });

  it("повторяющийся платёж — по разделу и близкой сумме (±10 %), иначе молчим", () => {
    expect(findAutoExpenseOverlap({ category: "OFFICE", note: "Аренда за октябрь", amount: 5000, currency: "TJS" }, autos, RATE)?.kind).toBe("recurring");
    expect(findAutoExpenseOverlap({ category: "OFFICE", note: "Свет", amount: 400, currency: "TJS" }, autos, RATE)).toBeNull();
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Мебель", amount: 5000, currency: "TJS" }, autos, RATE)).toBeNull();
  });

  it("обычные строки октября из той же таблицы не задеты", () => {
    for (const note of ["МАСТЕР УСТАНОВКА МЕБЕЛИ", "ОПЛАТА ЗА СВЕТ ОФИС", "ПЕРЕВОЗКА+РАБОЧИЕ МЕБЕЛЬ", "ОТЧЕТ ОМОР (статистика)", "З/П УБОРЩИЦА"]) {
      expect(findAutoExpenseOverlap({ category: "OTHER", note, amount: 1500, currency: "TJS" }, autos, RATE)).toBeNull();
    }
  });

  it("нулевая автоматическая строка ничего не перекрывает", () => {
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Таргет инстаграм", amount: 100, currency: "TJS" }, [{ ...metaOctober, amount: 0 }], RATE)).toBeNull();
  });
});

describe("канал рекламы по словам строки", () => {
  it("«инстаграм-фейсбук» — один кабинет Meta (Instagram), а не «не узнала»", () => {
    expect(adChannelOf("ТАРГЕТ (инстаграм-фейсбук)")).toBe("INSTAGRAM");
    expect(adChannelOf("Instagram и TikTok")).toBeNull();
    expect(adChannelOf("Реклама фейсбук")).toBe("FACEBOOK");
  });
});
