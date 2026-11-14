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
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Оплата Claude API", amount: 20, currency: "USD" }, autos, RATE)?.kind).toBe("ai");
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

describe("ложные срабатывания и пропуски (ревью 14.11)", () => {
  const kinds = (row: Parameters<typeof manualExpenseAutoKinds>[0]) => manualExpenseAutoKinds(row);
  it("люди и посевы — не кабинет Meta: таргетолог, блогер, СММ; зарплата — никогда не реклама", () => {
    expect(kinds({ category: "OTHER", note: "Услуги таргетолога", amount: 1 })).toEqual([]);
    expect(kinds({ category: "SALARY", agentId: "a", note: "Зарплата таргетолога", amount: 1 })).toEqual(["deal_salary"]);
    expect(kinds({ category: "ADVERTISING", source: "INSTAGRAM", note: "Реклама у блогера", amount: 1 })).toEqual(["ads_other"]);
    expect(kinds({ category: "OTHER", note: "СММ инстаграм реклама", amount: 1 })).toEqual([]);
  });
  it("явный канал сильнее слов: «таргет» в TikTok — не Meta", () => {
    expect(kinds({ category: "ADVERTISING", source: "TIKTOK", note: "Таргет", amount: 1 })).toEqual(["ads_other"]);
  });
  it("подписки на ИИ — не обращения CRM", () => {
    for (const note of ["Подписка ChatGPT Plus", "Claude Pro", "AI конференция"]) expect(kinds({ category: "OTHER", note, amount: 1 })).toEqual([]);
    expect(kinds({ category: "OTHER", note: "Оплата «ИИ»", amount: 1 })).toEqual(["ai"]);
  });
  it("кириллица на границах слов и таджикское «таблиғ»", () => {
    expect(kinds({ category: "OTHER", note: "реклама инста", amount: 1 })).toEqual(["ads_meta"]);
    expect(kinds({ category: "OTHER", note: "Таблиғ дар Инстаграм", amount: 1 })).toEqual(["ads_meta"]);
    expect(kinds({ category: "OTHER", note: "Инстаграмм аккаунт ремонт", amount: 1 })).toEqual([]);
  });
  it("оклад агента не переспрашивается, доля по сделке — да", () => {
    expect(findAutoExpenseOverlap({ category: "SALARY", agentId: "agent-1", note: "Оклад за октябрь", amount: 3000, currency: "TJS" }, autos, RATE)).toBeNull();
    expect(findAutoExpenseOverlap({ category: "SALARY", agentId: "agent-1", note: "Оклад", amount: 12000, currency: "TJS" }, autos, RATE)?.kind).toBe("deal_salary");
  });
  it("шаблон зарплаты одного агента не перекрывает зарплату другого с той же суммой", () => {
    const tpl = { autoKey: "rec:t:2026-10", category: "SALARY", amount: 3000, currency: "TJS", exchangeRate: 1, agentId: "agent-a" };
    expect(findAutoExpenseOverlap({ category: "SALARY", agentId: "agent-b", note: "Оклад", amount: 3000, currency: "TJS" }, [tpl], RATE)).toBeNull();
    expect(findAutoExpenseOverlap({ category: "SALARY", agentId: "agent-a", note: "Оклад", amount: 3000, currency: "TJS" }, [tpl], RATE)?.kind).toBe("recurring");
  });
});

describe("канал рекламы по словам строки", () => {
  it("«инстаграм-фейсбук» — один кабинет Meta (Instagram), а не «не узнала»", () => {
    expect(adChannelOf("ТАРГЕТ (инстаграм-фейсбук)")).toBe("INSTAGRAM");
    expect(adChannelOf("Instagram и TikTok")).toBeNull();
    expect(adChannelOf("Реклама фейсбук")).toBe("FACEBOOK");
  });
});
