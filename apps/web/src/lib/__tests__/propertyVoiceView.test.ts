import { describe, expect, it } from "vitest";
import type { PropertyVoicePriceCut, PropertyVoiceResponse } from "@royal-home/shared";
import {
  buildVoiceFunnel,
  buildVoiceTopics,
  costPerInquiry,
  dealStageLabel,
  daysSinceText,
  priceReaction,
  sharePercent,
  signedPercent,
  weekLabel,
  weeklyBars,
} from "../propertyVoiceView";

function voice(over: Partial<PropertyVoiceResponse> = {}): PropertyVoiceResponse {
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
    ads: { adsCount: 0, moneyHidden: false, spendTjs: null, spendOriginal: null, currency: null, impressions: 0, clicks: 0, conversations: 0, botConversations: 0 },
    diagnosis: [],
    ...over,
  };
}

describe("buildVoiceFunnel", () => {
  it("пустой объект: четыре ступени с нулями, без полос и долей", () => {
    const steps = buildVoiceFunnel(voice());
    expect(steps.map((s) => s.key)).toEqual(["sent", "opened", "showing", "deal"]);
    expect(steps.every((s) => s.count === 0 && s.barPct === 0 && s.shareOfPrev === null)).toBe(true);
  });

  it("числа, люди и доля от прошлой ступени; самая длинная полоса — 100", () => {
    const v = voice();
    v.interest.byKind = [
      { kind: "SHARE_SENT", events: 40, people: 25 },
      { kind: "SHARE_OPENED", events: 10, people: 8 },
    ];
    v.questions.showings = { total: 4, conducted: 3, declined: 0, uniqueClients: 3 };
    const [sent, opened, showing, deal] = buildVoiceFunnel(v);
    expect(sent).toMatchObject({ count: 40, people: 25, barPct: 100, shareOfPrev: null });
    expect(opened).toMatchObject({ count: 10, people: 8, barPct: 25, shareOfPrev: 25 });
    expect(showing).toMatchObject({ count: 4, people: 3, shareOfPrev: 40 });
    expect(deal).toMatchObject({ count: 0, people: null, barPct: 0 });
  });

  it("показ берётся там, где его больше: таблица показов или события интереса", () => {
    const v = voice();
    v.interest.byKind = [{ kind: "SHOWING", events: 5, people: 4 }];
    v.questions.showings = { total: 2, conducted: 1, declined: 0, uniqueClients: 2 };
    expect(buildVoiceFunnel(v)[2]).toMatchObject({ count: 5, people: 4 });
  });

  it("малая ненулевая ступень не пропадает: полоса не уже 4%, доля не выше 100%", () => {
    const v = voice();
    v.interest.byKind = [
      { kind: "SHARE_SENT", events: 2, people: 2 },
      { kind: "SHARE_OPENED", events: 3, people: 3 },
    ];
    v.bargaining.deals = [
      { stage: "COMPLETED", soldPrice: 1, listPrice: 1, currency: "TJS", listCurrency: "TJS", discountPct: 0, closedAt: null },
    ];
    const steps = buildVoiceFunnel(v);
    expect(steps[1].shareOfPrev).toBe(100);
    expect(steps[3].count).toBe(1);
    expect(steps[3].barPct).toBeGreaterThanOrEqual(4);
  });
});

describe("воронка: ступень «Сделка»", () => {
  const deal = (stage: string) => ({
    stage,
    soldPrice: 1,
    listPrice: 1,
    currency: "TJS",
    listCurrency: "TJS",
    discountPct: 0,
    closedAt: null,
  });

  it("продана только завершённая сделка: ожидание одобрения и ранние стадии ступень не наращивают", () => {
    const v = voice();
    v.bargaining.deals = [deal("PENDING_APPROVAL"), deal("CONTRACT_SIGNED"), deal("NEGOTIATION")];
    expect(buildVoiceFunnel(v)[3].count).toBe(0);
    v.bargaining.deals.push(deal("COMPLETED"));
    expect(buildVoiceFunnel(v)[3].count).toBe(1);
  });

  it("подпись по стадии: «продано» — только у COMPLETED", () => {
    expect(dealStageLabel("COMPLETED")).toBe("продано за");
    expect(dealStageLabel("PENDING_APPROVAL")).not.toMatch(/продано/);
    expect(dealStageLabel("NEGOTIATION")).not.toMatch(/продано/);
  });
});

describe("buildVoiceTopics", () => {
  it("сводит три источника, сортирует по частоте и метит цену", () => {
    const v = voice();
    v.questions.comments.escalated.topTexts = [{ text: "Почему так дорого?", count: 3 }];
    v.questions.callObjections.top = [
      { text: "шумно", count: 2 },
      { text: "рассрочка есть", count: 2 },
    ];
    const rows = buildVoiceTopics(v);
    expect(rows.map((r) => [r.source, r.text, r.count, r.price])).toEqual([
      ["comments", "Почему так дорого?", 3, true],
      ["calls", "рассрочка есть", 2, true],
      ["calls", "шумно", 2, false],
    ]);
  });

  it("одинаковые вопросы собственнику сводятся, регистр и пробелы не мешают", () => {
    const v = voice();
    const q = (question: string) => ({ question, answer: null, askedAt: "2026-10-01T10:00:00.000Z", answeredAt: null });
    v.questions.ownerQuestions.items = [q("Торг возможен?"), q("торг  возможен?"), q("Есть ли ремонт?")];
    const rows = buildVoiceTopics(v);
    expect(rows[0]).toMatchObject({ source: "owner", count: 2, price: true });
    expect(rows[1]).toMatchObject({ text: "Есть ли ремонт?", count: 1, price: false });
  });

  it("пустой ответ — пустой список, ничего не выдумываем", () => {
    expect(buildVoiceTopics(voice())).toEqual([]);
  });
});

describe("weeklyBars", () => {
  it("пик — 100, ненулевая неделя не ниже 6, нулевая — 0", () => {
    const { bars, total, peak } = weeklyBars([
      { weekStart: "2026-09-14", events: 0, people: 0 },
      { weekStart: "2026-09-21", events: 1, people: 1 },
      { weekStart: "2026-09-28", events: 50, people: 20 },
    ]);
    expect(bars.map((b) => b.heightPct)).toEqual([0, 6, 100]);
    expect(total).toBe(51);
    expect(peak).toBe(50);
  });

  it("тихий объект: ноль событий и ноль пика", () => {
    expect(weeklyBars([{ weekStart: "2026-09-28", events: 0, people: 0 }])).toMatchObject({ total: 0, peak: 0 });
    expect(weeklyBars([])).toEqual({ bars: [], total: 0, peak: 0 });
  });

  it("подпись недели — ДД.ММ", () => {
    expect(weekLabel("2026-09-28")).toBe("28.09");
  });
});

describe("priceReaction", () => {
  const cut = (over: Partial<PropertyVoicePriceCut>): PropertyVoicePriceCut => ({
    at: "2026-09-01T10:00:00.000Z",
    oldPrice: 100,
    newPrice: 95,
    oldCurrency: "TJS",
    newCurrency: "TJS",
    deltaPct: -5,
    eventsBefore: 4,
    eventsAfter: 9,
    daysAfterObserved: 14,
    ...over,
  });

  it("старше окна — «сравнить нечем», а не нули", () => {
    expect(priceReaction(cut({ eventsBefore: null, eventsAfter: null, daysAfterObserved: null }), 14).tone).toBe("unknown");
  });
  it("«после» ещё копится", () => {
    const r = priceReaction(cut({ daysAfterObserved: 3 }), 14);
    expect(r.tone).toBe("pending");
    expect(r.text).toContain("копится");
  });
  it("рост, без изменений, спад", () => {
    expect(priceReaction(cut({}), 14).tone).toBe("up");
    expect(priceReaction(cut({ eventsAfter: 4 }), 14).tone).toBe("flat");
    const down = priceReaction(cut({ eventsAfter: 1 }), 14);
    expect(down.tone).toBe("down");
    expect(down.text).toContain("4 до и 1 после");
  });
});

describe("мелкие подписи", () => {
  it("процент со знаком, настоящий минус и запятая", () => {
    expect(signedPercent(-5)).toBe("−5%");
    expect(signedPercent(3.5)).toBe("+3,5%");
    expect(signedPercent(0)).toBe("0%");
    expect(signedPercent(null)).toBeNull();
  });
  it("доля клиента", () => {
    expect(sharePercent(0.333)).toBe("33%");
    expect(sharePercent(null)).toBeNull();
  });
  it("дней с последнего интереса", () => {
    expect(daysSinceText(null)).toBe("интереса не было ни разу");
    expect(daysSinceText(0)).toBe("сегодня");
    expect(daysSinceText(1)).toBe("1 день назад");
    expect(daysSinceText(3)).toBe("3 дня назад");
    expect(daysSinceText(12)).toBe("12 дней назад");
  });
});

describe("costPerInquiry", () => {
  const ads = (over: Partial<PropertyVoiceResponse["ads"]>) => ({ ...voice().ads, ...over });
  it("расход делится на переписки рекламной системы", () => {
    expect(costPerInquiry(ads({ spendTjs: 300, conversations: 4 }))).toEqual({ value: 75, inquiries: 4, basis: "ads" });
  });
  it("переписок из системы нет — берём диалоги бота, но не складываем с ними", () => {
    expect(costPerInquiry(ads({ spendTjs: 300, conversations: 0, botConversations: 3 }))).toEqual({ value: 100, inquiries: 3, basis: "bot" });
    expect(costPerInquiry(ads({ spendTjs: 300, conversations: 2, botConversations: 3 }))?.inquiries).toBe(2);
  });
  it("нет расхода или нет обращений — цены нет", () => {
    expect(costPerInquiry(ads({ spendTjs: null, conversations: 5 }))).toBeNull();
    expect(costPerInquiry(ads({ spendTjs: 0, conversations: 5 }))).toBeNull();
    expect(costPerInquiry(ads({ spendTjs: 300 }))).toBeNull();
  });
});
