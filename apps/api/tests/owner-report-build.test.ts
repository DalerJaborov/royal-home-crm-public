import { describe, expect, it } from "vitest";
import type { PropertyVoiceResponse } from "@royal-home/shared";
import { diagnoseProperty } from "../src/lib/propertyVoice/diagnosis.js";
import { buildOwnerReport, type OwnerReportInput } from "../src/lib/ownerReport/build.js";
import { buildOwnerReportTopics, topicsOfText } from "../src/lib/ownerReport/topics.js";

/**
 * «Отчёт владельцу» — чистая сборка, без базы. Проверяется: рекомендация выбирается по
 * кодам диагноза «голоса рынка» (а не по своим порогам), темы считаются без цитат и
 * имён, в тексте и цифрах-доказательствах нет денег компании.
 */

type Voice = Omit<PropertyVoiceResponse, "diagnosis">;

function emptyVoice(): Voice {
  return {
    propertyId: "p1",
    generatedAt: "2026-10-07T12:00:00.000Z",
    windowDays: 3650,
    windowFrom: "2016-10-07T12:00:00.000Z",
    interest: {
      events: 0,
      people: 0,
      byKind: [],
      lastEventAt: null,
      daysSinceLastEvent: null,
      weekly: [
        { weekStart: "2026-09-21", events: 0, people: 0 },
        { weekStart: "2026-09-28", events: 0, people: 0 },
      ],
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
  };
}

function withDiagnosis(voice: Voice, daysOnSale: number | null, onSale = true): PropertyVoiceResponse {
  return { ...voice, diagnosis: diagnoseProperty(voice, { onSale, daysOnSale }) };
}

function input(voiceAll: PropertyVoiceResponse, overrides: Partial<OwnerReportInput["property"]> = {}): OwnerReportInput {
  const week = withDiagnosis(emptyVoice(), 10);
  return {
    now: new Date("2026-10-07T12:00:00.000Z"),
    agency: { name: "Royal Home", slogan: "Агентство недвижимости", logoUrl: null },
    property: {
      title: "2-комнатная, Шохмансур",
      rooms: 2,
      district: "Шохмансур",
      city: "Душанбе",
      price: 650_000,
      currency: "TJS",
      photoUrl: null,
      saleStatus: "AVAILABLE",
      daysOnSale: 10,
      ...overrides,
    },
    week: { voice: week, contacts: 0, siteViews: null },
    all: { voice: voiceAll, contacts: 4, siteViews: 120 },
  };
}

function strongDemandVoice(): Voice {
  const v = emptyVoice();
  v.interest.events = 14;
  v.interest.people = 6;
  v.interest.exposures = { total: 9, uniquePeople: 6, clientShared: 4, clientSharedShare: 0.44, byKind: [] };
  v.questions.showings = { total: 3, conducted: 3, declined: 0, uniqueClients: 3 };
  return v;
}

function priceComplaintsVoice(): Voice {
  const v = emptyVoice();
  v.interest.events = 12;
  v.interest.people = 5;
  v.interest.exposures = { total: 8, uniquePeople: 5, clientShared: 0, clientSharedShare: 0, byKind: [] };
  v.questions.showings = { total: 4, conducted: 4, declined: 0, uniqueClients: 4 };
  v.questions.callObjections = {
    calls: 4,
    top: [
      { text: "Дорого, можно скидку?", count: 3 },
      { text: "Какой этаж", count: 1 },
    ],
  };
  v.questions.refusals = { total: 2, byReason: [{ key: "EXPENSIVE", label: "Дорого", count: 2 }] };
  return v;
}

describe("buildOwnerReport: рекомендация по кодам диагноза", () => {
  it("сильный спрос → «держим цену» с цифрами-доказательствами", () => {
    const report = buildOwnerReport(input(withDiagnosis(strongDemandVoice(), 20)));
    expect(report.nextStep.kind).toBe("HOLD_PRICE");
    expect(report.nextStep.evidence.join(" ")).toContain("4 раза");
    expect(report.nextStep.evidence.join(" ")).toContain("Людей среди получателей: 6");
  });

  it("жалобы на цену → «обсудить цену», доказательства — число показов и упоминаний цены", () => {
    const voice = withDiagnosis(priceComplaintsVoice(), 20);
    expect(voice.diagnosis.map((d) => d.code)).toContain("PRICE_OBJECTIONS");
    const report = buildOwnerReport(input(voice));
    expect(report.nextStep.kind).toBe("DISCUSS_PRICE");
    expect(report.nextStep.title).toBe("Стоит обсудить цену");
    expect(report.nextStep.evidence).toContain("Проведено показов: 4");
    // 3 упоминания в звонках («дорого» и «скидку» — торг) + 2 отказа «дорого».
    expect(report.nextStep.evidence.some((e) => e.startsWith("Вопросов и возражений про цену и торг: 5"))).toBe(true);
    expect(report.nextStep.text).not.toMatch(/обещаем|гарантируем/i);
  });

  it("цена приоритетнее сильного спроса, если сработали оба правила", () => {
    const v = priceComplaintsVoice();
    v.interest.exposures = { total: 9, uniquePeople: 6, clientShared: 4, clientSharedShare: 0.44, byKind: [] };
    const voice = withDiagnosis(v, 20);
    const codes = voice.diagnosis.map((d) => d.code);
    expect(codes).toContain("STRONG_DEMAND");
    expect(codes).toContain("PRICE_OBJECTIONS");
    expect(buildOwnerReport(input(voice)).nextStep.kind).toBe("DISCUSS_PRICE");
  });

  it("пустой давний объект → «обновить фото и ролик»", () => {
    const report = buildOwnerReport(input(withDiagnosis(emptyVoice(), 45), { daysOnSale: 45 }));
    expect(report.nextStep.kind).toBe("REFRESH_MEDIA");
    expect(report.nextStep.evidence).toContain("В продаже: 45 дней");
  });

  it("пустой свежий объект → «пока набираем статистику», без выводов", () => {
    const report = buildOwnerReport(input(withDiagnosis(emptyVoice(), 5), { daysOnSale: 5 }));
    expect(report.nextStep.kind).toBe("WAIT");
  });

  it("мало данных у давнего объекта (не молчание) → «обновить фото и ролик»", () => {
    const v = emptyVoice();
    v.interest.events = 2;
    v.interest.people = 2;
    v.interest.exposures = { total: 2, uniquePeople: 2, clientShared: 0, clientSharedShare: 0, byKind: [] };
    const report = buildOwnerReport(input(withDiagnosis(v, 20), { daysOnSale: 20 }));
    expect(report.nextStep.kind).toBe("REFRESH_MEDIA");
  });

  it("не в продаже → отдельный честный текст без советов по цене", () => {
    const report = buildOwnerReport(input(withDiagnosis(emptyVoice(), null, false), { saleStatus: "SOLD", daysOnSale: null }));
    expect(report.nextStep.kind).toBe("NOT_ON_SALE");
    expect(report.nextStep.evidence).toEqual([]);
  });

  it("нет проблемных правил → «продолжаем работу»", () => {
    const v = emptyVoice();
    v.interest.events = 8;
    v.interest.people = 4;
    v.interest.exposures = { total: 6, uniquePeople: 4, clientShared: 0, clientSharedShare: 0, byKind: [] };
    v.questions.showings = { total: 1, conducted: 1, declined: 0, uniqueClients: 1 };
    const report = buildOwnerReport(input(withDiagnosis(v, 20)));
    expect(report.nextStep.kind).toBe("KEEP_WORKING");
  });
});

describe("buildOwnerReport: числа и состав ответа", () => {
  it("периоды, динамика по неделям и реклама без денег", () => {
    const v = strongDemandVoice();
    v.questions.comments.total = 7;
    v.interest.weekly = [
      { weekStart: "2026-09-28", events: 3, people: 2 },
      { weekStart: "2026-10-05", events: 6, people: 4 },
    ];
    v.ads = { ...v.ads, adsCount: 2, impressions: 5400, conversations: 9, botConversations: 12 };
    const report = buildOwnerReport(input(withDiagnosis(v, 20)));

    expect(report.periods.all).toEqual({
      shownToClients: 9,
      contacts: 4,
      showings: 3,
      comments: 7,
      siteViews: 120,
      // обращений из рекламы — большее из двух счётчиков, а не сумма
      ads: { impressions: 5400, inquiries: 12 },
    });
    expect(report.periods.week.siteViews).toBeNull();
    expect(report.periods.week.ads).toBeNull();
    expect(report.weekly).toEqual([
      { weekStart: "2026-09-28", events: 3, people: 2 },
      { weekStart: "2026-10-05", events: 6, people: 4 },
    ]);
    expect(Object.keys(report.periods.all.ads!).sort()).toEqual(["impressions", "inquiries"]);
    expect(report.generatedAt).toBe("2026-10-07T12:00:00.000Z");
  });

  it("в JSON нет денег рекламы ни в каком виде", () => {
    const v = priceComplaintsVoice();
    // Даже если вызывающий по ошибке передал деньги — рекомендация их не повторяет.
    v.ads = { ...v.ads, adsCount: 1, moneyHidden: false, spendTjs: 4321, spendOriginal: 400, currency: "USD", impressions: 100 };
    const json = JSON.stringify(buildOwnerReport(input(withDiagnosis(v, 20))));
    expect(json).not.toContain("4321");
    expect(json).not.toMatch(/spend|сомони|расход|commission|комисс/i);
  });
});

describe("темы вопросов", () => {
  it("topicsOfText: цена, торг, документы, состояние, район, этаж", () => {
    expect(topicsOfText("Какая цена?")).toEqual(["PRICE"]);
    expect(topicsOfText("Нарх чанд аст?")).toEqual(["PRICE"]);
    expect(topicsOfText("Дорого")).toEqual(["PRICE"]);
    // торг исключает цену для того же текста: одно сообщение — одно упоминание
    expect(topicsOfText("можно поторговаться?")).toEqual(["BARGAIN"]);
    expect(topicsOfText("Есть техпаспорт и документы?")).toEqual(["DOCUMENTS"]);
    expect(topicsOfText("в каком состоянии ремонт")).toEqual(["CONDITION"]);
    expect(topicsOfText("рядом школа и остановка, какой район")).toEqual(["DISTRICT"]);
    expect(topicsOfText("какой этаж, есть лифт")).toEqual(["FLOOR"]);
    expect(topicsOfText("какой этаж и документы есть")).toEqual(["DOCUMENTS", "FLOOR"]);
    expect(topicsOfText("здравствуйте")).toEqual([]);
  });

  it("не путает слова: «ценный» и «этажерка» темами не становятся", () => {
    expect(topicsOfText("ценный совет")).toEqual([]);
  });

  it("buildOwnerReportTopics: только ключ, подпись и число; порядок по убыванию; не больше пяти", () => {
    const v = emptyVoice();
    v.questions.comments.escalated.topTexts = [
      { text: "Позвоните мне +992 90 123 45 67, какая цена?", count: 2 },
      { text: "Есть документы? Иван Петров спрашивает", count: 1 },
    ];
    v.questions.callObjections.top = [
      { text: "дорого", count: 4 },
      { text: "какой этаж", count: 1 },
      { text: "в каком состоянии ремонт", count: 1 },
      { text: "рядом школа", count: 1 },
      { text: "можно скидку", count: 1 },
    ];
    const topics = buildOwnerReportTopics(v);
    expect(topics.length).toBeLessThanOrEqual(5);
    expect(topics[0]).toEqual({ key: "PRICE", label: "Цена", count: 6 });
    for (const t of topics) expect(Object.keys(t).sort()).toEqual(["count", "key", "label"]);
    const json = JSON.stringify(topics);
    expect(json).not.toContain("992");
    expect(json).not.toContain("Иван");
  });

  it("причина отказа «дорого» идёт в тему «Цена»", () => {
    const v = emptyVoice();
    v.questions.refusals = { total: 3, byReason: [{ key: "EXPENSIVE", label: "Дорого", count: 3 }] };
    expect(buildOwnerReportTopics(v)).toEqual([{ key: "PRICE", label: "Цена", count: 3 }]);
  });

  it("пустой объект → тем нет, а не выдуманные", () => {
    expect(buildOwnerReportTopics(emptyVoice())).toEqual([]);
  });
});
