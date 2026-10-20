import { describe, expect, it } from "vitest";
import { isPriceObjectionText, type PropertyVoiceResponse } from "@royal-home/shared";
import { diagnoseProperty, type DiagnosisContext } from "../src/lib/propertyVoice/diagnosis.js";
import { foldPropertyVoice, type PropertyVoiceRaw } from "../src/lib/propertyVoice/aggregate.js";

/**
 * Диагноз «почему объект не продаётся» — чистые правила, без базы. Проверяется, что
 * каждое правило срабатывает на своих цифрах, молчит на малых выборках и на пустом
 * объекте и что в ответе всегда есть цифры-доказательства.
 */

type Voice = Omit<PropertyVoiceResponse, "diagnosis">;

const ON_SALE: DiagnosisContext = { onSale: true, daysOnSale: 10 };

function emptyVoice(): Voice {
  return {
    propertyId: "p1",
    generatedAt: "2026-10-07T12:00:00.000Z",
    windowDays: 180,
    windowFrom: "2026-04-10T12:00:00.000Z",
    interest: {
      events: 0,
      people: 0,
      byKind: [],
      lastEventAt: null,
      daysSinceLastEvent: null,
      weekly: [],
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
      moneyHidden: false,
      spendTjs: null,
      spendOriginal: null,
      currency: null,
      impressions: 0,
      clicks: 0,
      conversations: 0,
      botConversations: 0,
    },
  };
}

/** Объект с заметным интересом: достаточно событий, чтобы правила не молчали из-за малых данных. */
function busyVoice(): Voice {
  const v = emptyVoice();
  v.interest.events = 20;
  v.interest.people = 8;
  v.interest.byKind = [
    { kind: "SHARE_SENT", events: 12, people: 6 },
    { kind: "SHARE_OPENED", events: 8, people: 5 },
  ];
  return v;
}

const codes = (v: Voice, ctx: DiagnosisContext = ON_SALE) => diagnoseProperty(v, ctx).map((d) => d.code);

describe("diagnoseProperty — общее", () => {
  it("объект не в продаже: один пункт и никаких выводов", () => {
    const out = diagnoseProperty(busyVoice(), { onSale: false, daysOnSale: 100 });
    expect(out.map((d) => d.code)).toEqual(["NOT_ON_SALE"]);
  });

  it("пустой молодой объект: только «данных мало», без ложных срабатываний", () => {
    const out = diagnoseProperty(emptyVoice(), ON_SALE);
    expect(out.map((d) => d.code)).toEqual(["FEW_DATA"]);
    expect(out[0].severity).toBe("info");
    expect(out[0].evidence.length).toBeGreaterThan(0);
  });

  it("срок в продаже неизвестен: молчаливый объект получает «данных мало», а не «интереса нет»", () => {
    expect(codes(emptyVoice(), { onSale: true, daysOnSale: null })).toEqual(["FEW_DATA"]);
  });

  it("каждый пункт несёт цифры-доказательства и заголовок", () => {
    const v = busyVoice();
    v.ads = { ...v.ads, spendTjs: 500, clicks: 40, impressions: 9000 };
    for (const d of diagnoseProperty(v, ON_SALE)) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
  });

  it("пункты идут от самых тяжёлых к лёгким", () => {
    const v = busyVoice();
    v.ads = { ...v.ads, spendTjs: 500 };
    v.interest.exposures = { total: 6, uniquePeople: 5, clientShared: 3, clientSharedShare: 0.5, byKind: [] };
    const order = diagnoseProperty(v, ON_SALE).map((d) => d.severity);
    expect(order).toEqual([...order].sort((a, b) => ["bad", "warn", "info"].indexOf(a) - ["bad", "warn", "info"].indexOf(b)));
  });
});

describe("diagnoseProperty — мало данных и тишина", () => {
  it("4 события — вывода нет", () => {
    const v = emptyVoice();
    v.interest.events = 4;
    v.interest.people = 4;
    expect(codes(v)).toEqual(["FEW_DATA"]);
  });

  it("5 событий — «мало данных» уже не говорим", () => {
    const v = emptyVoice();
    v.interest.events = 5;
    v.interest.people = 4;
    expect(codes(v)).not.toContain("FEW_DATA");
  });

  it("давно в продаже и нет вообще никакого интереса — «интереса нет», предупреждение", () => {
    const out = diagnoseProperty(emptyVoice(), { onSale: true, daysOnSale: 45 });
    expect(out.map((d) => d.code)).toEqual(["NO_INTEREST"]);
    expect(out[0].severity).toBe("warn");
  });

  it("два месяца тишины — красный флаг", () => {
    const out = diagnoseProperty(emptyVoice(), { onSale: true, daysOnSale: 75 });
    expect(out[0].code).toBe("NO_INTEREST");
    expect(out[0].severity).toBe("bad");
  });

  it("давно в продаже, но комментарии есть — это не «нет интереса совсем»", () => {
    const v = emptyVoice();
    v.questions.comments.total = 2;
    expect(codes(v, { onSale: true, daysOnSale: 90 })).toEqual(["FEW_DATA"]);
  });

  it("молодой объект без интереса — рано судить", () => {
    expect(codes(emptyVoice(), { onSale: true, daysOnSale: 29 })).toEqual(["FEW_DATA"]);
  });
});

describe("diagnoseProperty — воронка застряла до показа", () => {
  it("много интереса, ноль показов — срабатывает", () => {
    const out = diagnoseProperty(busyVoice(), ON_SALE);
    const d = out.find((x) => x.code === "STUCK_BEFORE_SHOWING");
    expect(d).toBeDefined();
    expect(d!.evidence.join(" ")).toContain("Показов: 0");
    expect(d!.evidence.join(" ")).toContain("Отправлено ссылок: 12");
  });

  it("есть показ — не срабатывает", () => {
    const v = busyVoice();
    v.questions.showings.total = 1;
    expect(codes(v)).not.toContain("STUCK_BEFORE_SHOWING");
  });

  it("показ виден только в событиях интереса — тоже не срабатывает", () => {
    const v = busyVoice();
    v.interest.byKind.push({ kind: "SHOWING", events: 1, people: 1 });
    expect(codes(v)).not.toContain("STUCK_BEFORE_SHOWING");
  });

  it("интерес от одного человека — не спрос", () => {
    const v = busyVoice();
    v.interest.people = 1;
    expect(codes(v)).not.toContain("STUCK_BEFORE_SHOWING");
  });

  it("9 событий — ещё не «много»", () => {
    const v = busyVoice();
    v.interest.events = 9;
    expect(codes(v)).not.toContain("STUCK_BEFORE_SHOWING");
  });
});

describe("diagnoseProperty — возражения о цене", () => {
  function withShowings(): Voice {
    const v = busyVoice();
    v.questions.showings = { total: 4, conducted: 3, declined: 0, uniqueClients: 3 };
    return v;
  }

  it("отказы «дорого» и слова про цену в звонках преобладают — срабатывает", () => {
    const v = withShowings();
    v.questions.refusals = { total: 3, byReason: [{ key: "EXPENSIVE", label: "Дорого", count: 3 }] };
    v.questions.callObjections = { calls: 2, top: [{ text: "дорого", count: 2 }, { text: "шумно", count: 1 }] };
    const d = diagnoseProperty(v, ON_SALE).find((x) => x.code === "PRICE_OBJECTIONS");
    expect(d).toBeDefined();
    // 3 отказа + 2 «дорого» = 5 из 3 + 3 = 6
    expect(d!.evidence.join(" ")).toContain("Про цену: 5 из 6");
  });

  it("назначенные и отменённые показы возражений не порождают: проведено 0 — молчит (APROP02, аудит 04.10.2026)", () => {
    const v = withShowings();
    v.questions.showings = { total: 4, conducted: 0, declined: 2, uniqueClients: 3 };
    v.questions.refusals = { total: 3, byReason: [{ key: "EXPENSIVE", label: "Дорого", count: 3 }] };
    v.questions.callObjections = { calls: 2, top: [{ text: "дорого", count: 2 }] };
    expect(codes(v)).not.toContain("PRICE_OBJECTIONS");
  });

  it("цена — меньше половины: молчит", () => {
    const v = withShowings();
    v.questions.refusals = { total: 4, byReason: [{ key: "EXPENSIVE", label: "Дорого", count: 3 }, { key: "WRONG_OBJECT", label: "Не то", count: 1 }] };
    v.questions.callObjections = { calls: 3, top: [{ text: "шумно", count: 2 }, { text: "далеко", count: 2 }, { text: "старый дом", count: 2 }] };
    expect(codes(v)).not.toContain("PRICE_OBJECTIONS");
  });

  it("одно-два упоминания цены — мало, молчит", () => {
    const v = withShowings();
    v.questions.callObjections = { calls: 1, top: [{ text: "торг возможен?", count: 2 }] };
    expect(codes(v)).not.toContain("PRICE_OBJECTIONS");
  });

  it("без показов правило не срабатывает, даже если в комментариях спорят о цене", () => {
    const v = busyVoice();
    v.questions.comments.escalated.topTexts = [{ text: "Почему так дорого?", count: 5 }];
    expect(codes(v)).not.toContain("PRICE_OBJECTIONS");
  });

  it("опросы после показа (только у директора) учитываются, если пришли", () => {
    const v = withShowings();
    v.showingFeedback = {
      calls: 3,
      byOutcome: [],
      quotes: [],
      redFlags: [{ text: "завышена цена", count: 3 }],
    };
    expect(codes(v)).toContain("PRICE_OBJECTIONS");
  });

  it("словарь: возражения узнаются, нейтральные вопросы и однокоренные «торговый» — нет", () => {
    expect(isPriceObjectionText("Это слишком дорого")).toBe(true);
    expect(isPriceObjectionText("Рассрочка есть?")).toBe(true);
    expect(isPriceObjectionText("Нарх қимат аст")).toBe(true);
    expect(isPriceObjectionText("Савдо мешавад?")).toBe(true);
    expect(isPriceObjectionText("Можно поторговаться?")).toBe(true);
    expect(isPriceObjectionText("Какая цена?")).toBe(false);
    expect(isPriceObjectionText("Нарх чанд?")).toBe(false);
    expect(isPriceObjectionText("Рядом торговый центр")).toBe(false);
    expect(isPriceObjectionText("Дорога шумная")).toBe(false);
  });
});

describe("diagnoseProperty — снижение цены", () => {
  const cut = (over: Partial<Voice["bargaining"]["priceChanges"][number]> = {}) => ({
    at: "2026-09-01T10:00:00.000Z",
    oldPrice: 100_000,
    newPrice: 95_000,
    oldCurrency: "TJS",
    newCurrency: "TJS",
    deltaPct: -5,
    eventsBefore: 6,
    eventsAfter: 6,
    daysAfterObserved: 14,
    ...over,
  });

  it("снизили, интерес не вырос — срабатывает, в доказательствах дата и цифры", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut()];
    const d = diagnoseProperty(v, ON_SALE).find((x) => x.code === "PRICE_CUT_NO_EFFECT");
    expect(d).toBeDefined();
    expect(d!.evidence[0]).toContain("2026-09-01");
    expect(d!.evidence[0]).toContain("до: 6 событий, после: 6");
  });

  it("интерес вырос в полтора раза и больше чем на 2 — молчит", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut({ eventsBefore: 4, eventsAfter: 8 })];
    expect(codes(v)).not.toContain("PRICE_CUT_NO_EFFECT");
  });

  it("рост на одно событие — шум, не «вернул»", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut({ eventsBefore: 1, eventsAfter: 2 })];
    expect(codes(v)).toContain("PRICE_CUT_NO_EFFECT");
  });

  it("«после» ещё копится (меньше 14 дней) — судить рано", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut({ daysAfterObserved: 5 })];
    expect(codes(v)).not.toContain("PRICE_CUT_NO_EFFECT");
  });

  it("изменение старше окна (null) и повышение цены — не рассматриваются", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut({ eventsBefore: null, eventsAfter: null, daysAfterObserved: null }), cut({ deltaPct: 4 }), cut({ deltaPct: null })];
    expect(codes(v)).not.toContain("PRICE_CUT_NO_EFFECT");
  });

  it("до и после ноль — это случай «интереса нет», а не «снижение не помогло»", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut({ eventsBefore: 0, eventsAfter: 0 })];
    expect(codes(v)).not.toContain("PRICE_CUT_NO_EFFECT");
  });

  it("одно из снижений сработало — не заявляем, что цена не помогла", () => {
    const v = busyVoice();
    v.bargaining.priceChanges = [cut(), cut({ at: "2026-08-01T10:00:00.000Z", eventsBefore: 2, eventsAfter: 9 })];
    expect(codes(v)).not.toContain("PRICE_CUT_NO_EFFECT");
  });
});

describe("diagnoseProperty — реклама", () => {
  it("расход есть, обращений нет — срабатывает", () => {
    const v = busyVoice();
    v.ads = { ...v.ads, adsCount: 1, spendTjs: 250.4, impressions: 10_000, clicks: 80 };
    const d = diagnoseProperty(v, ON_SALE).find((x) => x.code === "ADS_NO_RESPONSE");
    expect(d).toBeDefined();
    expect(d!.evidence.join(" ")).toContain("250");
  });

  it("есть переписка из рекламы (в системе рекламы или в боте) — молчит", () => {
    const a = busyVoice();
    a.ads = { ...a.ads, spendTjs: 500, conversations: 2 };
    const b = busyVoice();
    b.ads = { ...b.ads, spendTjs: 500, botConversations: 1 };
    expect(codes(a)).not.toContain("ADS_NO_RESPONSE");
    expect(codes(b)).not.toContain("ADS_NO_RESPONSE");
  });

  it("расход меньше порога или рекламы не было — молчит", () => {
    const a = busyVoice();
    a.ads = { ...a.ads, spendTjs: 99 };
    expect(codes(a)).not.toContain("ADS_NO_RESPONSE");
    expect(codes(busyVoice())).not.toContain("ADS_NO_RESPONSE");
  });
});

describe("diagnoseProperty — клиенты сами присылают объект", () => {
  it("высокая доля — «сильный спрос», информационный пункт", () => {
    const v = busyVoice();
    v.interest.exposures = { total: 10, uniquePeople: 8, clientShared: 4, clientSharedShare: 0.4, byKind: [] };
    const d = diagnoseProperty(v, ON_SALE).find((x) => x.code === "STRONG_DEMAND");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("info");
    expect(d!.evidence[0]).toContain("4 раз из 10");
  });

  it("две присылки — случайность; низкая доля — шум", () => {
    const a = busyVoice();
    a.interest.exposures = { total: 3, uniquePeople: 3, clientShared: 2, clientSharedShare: 0.67, byKind: [] };
    const b = busyVoice();
    b.interest.exposures = { total: 30, uniquePeople: 20, clientShared: 4, clientSharedShare: 0.13, byKind: [] };
    expect(codes(a)).not.toContain("STRONG_DEMAND");
    expect(codes(b)).not.toContain("STRONG_DEMAND");
  });
});

describe("foldPropertyVoice отдаёт диагноз", () => {
  const NOW = new Date("2026-10-07T12:00:00Z");
  const raw = (property: PropertyVoiceRaw["property"]): PropertyVoiceRaw => ({
    now: NOW,
    windowDays: 180,
    windowStart: new Date(NOW.getTime() - 180 * 86_400_000),
    property,
    interestEvents: [],
    lastEventAt: null,
    exposures: [],
    conversationSources: [],
    comments: [],
    ownerQuestions: [],
    callObjections: [],
    showings: [],
    refusalReasons: [],
    priceChanges: [],
    deals: [],
    dealsOwnOnly: false,
    ads: { adsCount: 0, moneyHidden: false, spendTjs: null, spendOriginal: null, currency: null, impressions: 0, clicks: 0, conversations: 0, botConversations: 0 },
    feedback: null,
  });

  it("поля срока и статуса пробрасываются в правила", () => {
    const quiet = foldPropertyVoice(raw({ id: "p", price: 1, currency: "TJS", onSale: true, daysOnSale: 50 }));
    expect(quiet.diagnosis.map((d) => d.code)).toEqual(["NO_INTEREST"]);
    const sold = foldPropertyVoice(raw({ id: "p", price: 1, currency: "TJS", onSale: false, daysOnSale: 50 }));
    expect(sold.diagnosis.map((d) => d.code)).toEqual(["NOT_ON_SALE"]);
    // Старые вызывающие без полей: «в продаже, срок неизвестен» — честное «данных мало».
    const legacy = foldPropertyVoice(raw({ id: "p", price: 1, currency: "TJS" }));
    expect(legacy.diagnosis.map((d) => d.code)).toEqual(["FEW_DATA"]);
  });
});
