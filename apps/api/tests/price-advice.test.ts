import { describe, expect, it } from "vitest";
import type { PriceWaitlistResponse, PropertyVoiceResponse } from "@royal-home/shared";
import { PRICE_WAITLIST_DROPS_PCT } from "@royal-home/shared";
import {
  ADVICE_MIN_NEW_CLIENTS,
  advisePrice,
  buildOwnerArgument,
  persuasiveStep,
  type PriceAdviceContext,
  type PriceAdviceVoice,
} from "../src/lib/priceAdvice.js";
import { stepPrice } from "../src/lib/priceWaitlist.js";

/**
 * Совет по цене — чистые правила, без базы. Проверяются: каждый вердикт, пустой объект, малые выборки,
 * отсутствие ложного «снизить» при сильном спросе и в окно наблюдения после снижения, и что в текстах нет обещаний.
 */

const ON_SALE: PriceAdviceContext = { onSale: true, daysOnSale: 20 };
const LONG_ON_SALE: PriceAdviceContext = { onSale: true, daysOnSale: 90 };

function week(events: number, i: number) {
  return { weekStart: `2026-09-${String(i + 1).padStart(2, "0")}`, events, people: Math.min(events, 3) };
}

function emptyVoice(): PriceAdviceVoice {
  return {
    propertyId: "p1",
    generatedAt: "2026-10-03T10:00:00.000Z",
    windowDays: 180,
    windowFrom: "2026-04-06T10:00:00.000Z",
    interest: {
      events: 0,
      people: 0,
      byKind: [],
      lastEventAt: null,
      daysSinceLastEvent: null,
      weekly: Array.from({ length: 12 }, (_, i) => week(0, i)),
      exposures: { total: 0, uniquePeople: 0, clientShared: 0, clientSharedShare: null, byKind: [] },
      conversations: { total: 0, bySource: [] },
    },
    questions: {
      comments: { total: 0, byChannel: [], byStatus: [], escalated: { count: 0, notes: [], topTexts: [] } },
      ownerQuestions: { total: 0, answered: 0, items: [] },
      callObjections: { calls: 0, top: [] },
      showings: { total: 0, conducted: 0, declined: 0, uniqueClients: 0 },
      refusals: { total: 0, byReason: [] },
    },
    bargaining: { priceChanges: [], deals: [], dealsOwnOnly: false },
    ads: {
      adsCount: 0,
      moneyHidden: true,
      spendTjs: null,
      spendOriginal: null,
      currency: null,
      impressions: 0,
      clicks: 0,
      conversations: 0,
      botConversations: 0,
    },
  } satisfies Omit<PropertyVoiceResponse, "diagnosis">;
}

/** Объект с умеренным, но не сильным интересом: 12 событий за окно, тихий последний месяц. */
function moderateVoice(): PriceAdviceVoice {
  const v = emptyVoice();
  v.interest.events = 12;
  v.interest.people = 5;
  v.interest.byKind = [{ kind: "SHARE_SENT", events: 12, people: 5 }];
  v.interest.weekly = Array.from({ length: 12 }, (_, i) => week(i < 8 ? 2 : 0, i)); // активно было, последние 4 недели тихо
  return v;
}

function withPriceObjections(v: PriceAdviceVoice): PriceAdviceVoice {
  v.questions.showings = { total: 3, conducted: 3, declined: 0, uniqueClients: 3 };
  v.questions.refusals = { total: 4, byReason: [{ key: "EXPENSIVE", count: 4 }] };
  return v;
}

function waitlist(over: Partial<PriceWaitlistResponse> = {}, additional: number[] = [0, 0, 0, 0, 0]): PriceWaitlistResponse {
  const fitNow = over.fitNow ?? 1;
  return {
    propertyId: "p1",
    generatedAt: "2026-10-03T10:00:00.000Z",
    price: 400_000,
    currency: "TJS",
    onSale: true,
    sample: 5,
    enoughData: true,
    fitNow,
    overBudget: 4,
    beyondLadder: 0,
    belowBudget: 0,
    noBudget: 0,
    truncated: false,
    steps: PRICE_WAITLIST_DROPS_PCT.map((dropPct, i) => ({
      dropPct,
      price: stepPrice(400_000, dropPct),
      additional: additional[i],
      total: fitNow + additional[i],
    })),
    visibleScope: "all",
    visibleClients: [],
    ...over,
  };
}

const PROMISES = /вернёт|вернет|продаст|гаранти|обязательно приведёт|точно|готовы смотреть|готов смотреть/i;

describe("advisePrice — не в продаже и мало данных", () => {
  it("объект не в продаже: insufficient_data", () => {
    const a = advisePrice(moderateVoice(), waitlist(), { onSale: false, daysOnSale: 10 });
    expect(a.verdict).toBe("insufficient_data");
    expect(a.ownerArgument).toBeNull();
  });

  it("пустой объект без листа ожидания: insufficient_data, не «снизить» и не «держать»", () => {
    const a = advisePrice(emptyVoice(), null, LONG_ON_SALE);
    expect(a.verdict).toBe("insufficient_data");
    expect(a.suggestedDropPct).toBeUndefined();
    expect(a.evidence.length).toBeGreaterThan(0);
  });

  it("малые выборки: 3 события и лист «мало данных» — insufficient_data, даже при тишине и долгой продаже", () => {
    const v = emptyVoice();
    v.interest.events = 3;
    v.interest.people = 2;
    const a = advisePrice(v, waitlist({ enoughData: false, sample: 2 }, [3, 3, 3, 3, 3]), LONG_ON_SALE);
    expect(a.verdict).toBe("insufficient_data");
    expect(a.ownerArgument).toBeNull();
  });

  it("мало событий, но лист ожидания достаточный — совет возможен", () => {
    const a = advisePrice(emptyVoice(), waitlist({}, [0, 2, 3, 3, 3]), LONG_ON_SALE);
    expect(a.verdict).not.toBe("insufficient_data");
  });
});

describe("advisePrice — hold", () => {
  it("один признак (только лист ожидания): держать, и аргумента для собственника нет (иначе он спорил бы с текстом рядом)", () => {
    const a = advisePrice(moderateVoice(), waitlist({}, [0, 2, 3, 3, 3]), ON_SALE);
    expect(a.verdict).toBe("hold");
    expect(a.text).toContain("один признак");
    expect(a.ownerArgument).toBeNull();
    // сама лестница остаётся в цифрах основания
    expect(a.evidence.join(" ")).toContain("Лист ожидания");
  });

  it("признаков нет вовсе: держать", () => {
    const a = advisePrice(moderateVoice(), waitlist(), ON_SALE);
    expect(a.verdict).toBe("hold");
    expect(a.suggestedDropPct).toBeUndefined();
    expect(a.ownerArgument).toBeNull();
  });

  it("СИЛЬНЫЙ СПРОС: даже при возражениях о цене и ждущих клиентах — держать, аргумент не выдаётся", () => {
    const v = withPriceObjections(moderateVoice());
    v.interest.events = 40;
    v.interest.people = 15;
    v.interest.weekly = Array.from({ length: 12 }, (_, i) => week(i >= 8 ? 6 : 1, i)); // 24 касания за последние 4 недели
    v.interest.byKind = [{ kind: "SHOWING", events: 5, people: 4 }];
    v.questions.showings.total = 5;
    const a = advisePrice(v, waitlist({}, [0, 3, 4, 4, 4]), LONG_ON_SALE);
    expect(a.verdict).toBe("hold");
    expect(a.suggestedDropPct).toBeUndefined();
    expect(a.ownerArgument).toBeNull();
    expect(a.text).toContain("спрос");
  });

  it("сильный спрос считается по ПРОВЕДЁННЫМ показам, а не по назначенным и отменённым (APROP02, аудит 04.10.2026)", () => {
    const v = withPriceObjections(moderateVoice());
    v.interest.events = 40;
    v.interest.people = 15;
    v.interest.weekly = Array.from({ length: 12 }, (_, i) => week(i >= 8 ? 6 : 1, i));
    // Событий SHOWING пять (назначения создают их сразу), записей пять, но проведён один.
    v.interest.byKind = [{ kind: "SHOWING", events: 5, people: 4 }];
    v.questions.showings = { total: 5, conducted: 1, declined: 2, uniqueClients: 4 };
    const a = advisePrice(v, waitlist({}, [0, 3, 4, 4, 4]), LONG_ON_SALE);
    expect(a.verdict).toBe("consider_drop");
  });

  it("клиенты сами присылают объект: держать независимо от тишины", () => {
    const v = withPriceObjections(moderateVoice());
    v.interest.exposures = { total: 8, uniquePeople: 6, clientShared: 4, clientSharedShare: 0.5, byKind: [] };
    const a = advisePrice(v, waitlist({}, [0, 3, 3, 3, 3]), LONG_ON_SALE);
    expect(a.verdict).toBe("hold");
  });

  it("цену снизили недавно, окно наблюдения не закончилось: держать", () => {
    const v = withPriceObjections(moderateVoice());
    v.bargaining.priceChanges = [
      { at: "2026-09-28T10:00:00.000Z", oldPrice: 420_000, newPrice: 400_000, oldCurrency: "TJS", newCurrency: "TJS", deltaPct: -4.8, eventsBefore: 1, eventsAfter: 1, daysAfterObserved: 5 },
    ];
    const a = advisePrice(v, waitlist({}, [0, 3, 3, 3, 3]), LONG_ON_SALE);
    expect(a.verdict).toBe("hold");
    expect(a.text).toContain("рано судить");
  });

  it("прошлые снижения не вернули интерес: одних «возражений или тишины» мало — держать", () => {
    const v = moderateVoice();
    v.bargaining.priceChanges = [
      { at: "2026-07-01T10:00:00.000Z", oldPrice: 440_000, newPrice: 400_000, oldCurrency: "TJS", newCurrency: "TJS", deltaPct: -9, eventsBefore: 4, eventsAfter: 4, daysAfterObserved: 14 },
    ];
    // Тишина (C) + ступень листа (B), но A нет, а прошлое снижение не помогло.
    const a = advisePrice(v, waitlist({}, [0, 2, 3, 3, 3]), LONG_ON_SALE);
    expect(a.verdict).toBe("hold");
    expect(a.text).toContain("не в цене");
  });
});

describe("advisePrice — consider_drop", () => {
  it("возражения о цене + ступень листа: снизить на ступень, с цифрами и аргументом", () => {
    const v = withPriceObjections(moderateVoice());
    const a = advisePrice(v, waitlist({}, [0, 2, 3, 3, 3]), ON_SALE);
    expect(a.verdict).toBe("consider_drop");
    expect(a.suggestedDropPct).toBe(5);
    expect(a.evidence.join(" ")).toContain("Лист ожидания");
    expect(a.evidence.join(" ")).toContain("Про цену 4 из 4");
    expect(a.ownerArgument).toContain("по анкете и бюджету");
    expect(a.ownerArgument).toContain("подходят 3 ждущих покупателя");
    expect(a.ownerArgument).toContain("380");
  });

  it("тишина + ступень листа без возражений: тоже снизить (два независимых признака)", () => {
    const a = advisePrice(moderateVoice(), waitlist({}, [0, 2, 3, 3, 3]), LONG_ON_SALE);
    expect(a.verdict).toBe("consider_drop");
    expect(a.suggestedDropPct).toBe(5);
  });

  it("возражения + тишина без листа ожидания: обсуждать цену можно, но цифры ступени нет", () => {
    const v = withPriceObjections(moderateVoice());
    const a = advisePrice(v, waitlist({ enoughData: false, sample: 1 }), LONG_ON_SALE);
    expect(a.verdict).toBe("consider_drop");
    expect(a.suggestedDropPct).toBeUndefined();
    expect(a.ownerArgument).toBeNull();
  });

  it("глубже 10 % ступень не называется: снижение на 15 % — не совет по данным", () => {
    const wl = waitlist({}, [0, 0, 0, 0, 4]);
    expect(persuasiveStep(wl)).toBeNull();
    const a = advisePrice(withPriceObjections(moderateVoice()), wl, ON_SALE);
    expect(a.suggestedDropPct).toBeUndefined();
  });

  it("один новый клиент — не очередь: ступень не убедительна", () => {
    expect(ADVICE_MIN_NEW_CLIENTS).toBe(2);
    expect(persuasiveStep(waitlist({}, [0, 1, 1, 1, 1]))).toBeNull();
  });

  it("при возражениях и ступени снижение остаётся советом, даже если прошлые снижения не помогли", () => {
    const v = withPriceObjections(moderateVoice());
    v.bargaining.priceChanges = [
      { at: "2026-07-01T10:00:00.000Z", oldPrice: 440_000, newPrice: 400_000, oldCurrency: "TJS", newCurrency: "TJS", deltaPct: -9, eventsBefore: 4, eventsAfter: 4, daysAfterObserved: 14 },
    ];
    expect(advisePrice(v, waitlist({}, [0, 2, 3, 3, 3]), ON_SALE).verdict).toBe("consider_drop");
  });
});

describe("тексты", () => {
  it("ни в одном исходе нет обещаний результата", () => {
    const cases = [
      advisePrice(emptyVoice(), null, ON_SALE),
      advisePrice(moderateVoice(), waitlist(), ON_SALE),
      advisePrice(withPriceObjections(moderateVoice()), waitlist({}, [0, 2, 3, 3, 3]), ON_SALE),
    ];
    for (const a of cases) {
      expect(a.text).not.toMatch(PROMISES);
      for (const e of a.evidence) expect(e).not.toMatch(PROMISES);
      if (a.ownerArgument) expect(a.ownerArgument).not.toMatch(PROMISES);
    }
  });

  it("аргумент для собственника: числа листа и решение за собственником, без имён", () => {
    const wl = waitlist({}, [0, 2, 3, 3, 3]);
    const step = wl.steps[1];
    const text = buildOwnerArgument(moderateVoice(), wl, step);
    expect(text).toContain("по анкете и бюджету при цене до");
    expect(text).toContain("подходят 3 ждущих покупателя");
    // данные не знают, кто готов смотреть: такого обещания в тексте быть не должно
    expect(text).not.toMatch(PROMISES);
    expect(text).toContain("−5%");
    expect(text).toContain("по бюджету подходит 1 ждущий покупатель");
    expect(text).toContain("Решение о цене остаётся за собственником.");
  });
});
