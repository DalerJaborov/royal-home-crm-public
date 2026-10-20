import { describe, expect, it } from "vitest";
import { PROPERTY_VOICE_WEEKS } from "@royal-home/shared";
import {
  dushanbeDaysBetween,
  dushanbeWeekStart,
  foldBargaining,
  foldComments,
  foldInterest,
  foldPropertyVoice,
  foldShowingFeedback,
  safeText,
  textKey,
  topTexts,
  type PropertyVoiceRaw,
} from "../src/lib/propertyVoice/aggregate.js";
import { pickProvenCallProperty } from "../src/lib/propertyVoice/callProperty.js";
import { commentMediaCandidates } from "../src/lib/propertyVoice/commentProperty.js";
import { refusalWindowStart, SHOWING_REFUSAL_WINDOW_DAYS } from "../src/lib/propertyVoice/showingProperty.js";

/**
 * «Голос рынка»: чистая свёртка — без базы. Проверяется то, что решает, ЧТО увидит
 * владелец: счёт интереса и недель, частотные тексты без телефонов, торг, доля
 * CLIENT_SHARED и — главное — что раздел с опросами покупателей после показа
 * появляется в ответе ТОЛЬКО у директора.
 */

const DAY = 24 * 3600_000;
// Среда 2026-10-07 12:00 по UTC (17:00 по Душанбе); неделя с понедельника 2026-10-05.
const NOW = new Date("2026-10-07T12:00:00Z");

function baseRaw(overrides: Partial<PropertyVoiceRaw> = {}): PropertyVoiceRaw {
  return {
    now: NOW,
    windowDays: 180,
    windowStart: new Date(NOW.getTime() - 180 * DAY),
    property: { id: "p1", price: 100_000, currency: "TJS" },
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
    feedback: null,
    ...overrides,
  };
}

describe("частотные тексты и маскировка", () => {
  it("сводит реплики без учёта регистра, пробелов и знаков на краях", () => {
    expect(textKey("  Нарх  чанд?! ")).toBe("нарх чанд");
    const top = topTexts(["Нарх чанд?", "нарх чанд", "Цена?", "  НАРХ   ЧАНД  "]);
    expect(top[0]).toEqual({ text: "Нарх чанд?", count: 3 });
    expect(top[1].count).toBe(1);
  });

  it("реплики с разными телефонами — одна строка: ключ строится от маскированного текста", () => {
    const top = topTexts(["Позвоните мне +992 900 11 22 33", "позвоните мне +992 911 44 55 66"]);
    expect(top).toHaveLength(1);
    expect(top[0].count).toBe(2);
    expect(top[0].text).not.toMatch(/\d{2} \d{2} \d{2}/);
    // Нет двух одинаковых строк в ответе: так на экране не бывает повторяющихся ключей.
    expect(new Set(top.map((t) => t.text)).size).toBe(top.length);
  });

  it("закрывает телефоны в тексте клиента", () => {
    expect(safeText("позвоните мне +992 900 12 34 56 пожалуйста")).not.toMatch(/900 12 34 56/);
    expect(topTexts(["мой номер 900123456, звоните"])[0].text).not.toMatch(/900123456/);
  });

  it("пустые и состоящие из знаков реплики не попадают в список", () => {
    expect(topTexts(["", "  ", "?!"])).toEqual([]);
  });

  it("длинный текст обрезается", () => {
    expect(safeText("а".repeat(1000)).length).toBeLessThanOrEqual(240);
  });
});

describe("недели по Душанбе", () => {
  it("понедельник недели и разница суток считаются по Душанбе, а не по UTC", () => {
    expect(dushanbeWeekStart(NOW)).toBe("2026-10-05");
    // Воскресенье 23:30 UTC — в Душанбе уже понедельник 04:30 следующей недели.
    expect(dushanbeWeekStart(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-05");
    expect(dushanbeWeekStart(new Date("2026-10-04T12:00:00Z"))).toBe("2026-09-28");
    // 23:30 UTC и 00:30 UTC следующего дня — это 04:30 и 05:30 ОДНИХ суток по Душанбе.
    expect(dushanbeDaysBetween(new Date("2026-10-06T23:30:00Z"), new Date("2026-10-07T00:30:00Z"))).toBe(0);
    expect(dushanbeDaysBetween(new Date("2026-10-01T10:00:00Z"), NOW)).toBe(6);
  });
});

describe("воронка интереса", () => {
  it("считает события, уникальных людей, виды, динамику и дни с последнего", () => {
    const raw = baseRaw({
      lastEventAt: new Date(NOW.getTime() - 3 * DAY),
      interestEvents: [
        { kind: "SHARE_SENT", createdAt: new Date(NOW.getTime() - 1 * DAY), personKey: "c:a" },
        { kind: "SHARE_OPENED", createdAt: new Date(NOW.getTime() - 1 * DAY), personKey: "c:a" },
        { kind: "COMMENT", createdAt: new Date(NOW.getTime() - 3 * DAY), personKey: "x:ig1" },
        { kind: "COMMENT", createdAt: new Date(NOW.getTime() - 10 * DAY), personKey: null },
        // Вне окна (старше 180 дней) — в счёт не идёт, хотя пришло «с запасом» для сравнения цен.
        { kind: "SHOWING", createdAt: new Date(NOW.getTime() - 185 * DAY), personKey: "c:z" },
      ],
    });
    const interest = foldInterest(raw);
    expect(interest.events).toBe(4);
    expect(interest.people).toBe(2); // c:a и x:ig1; безымянный не считается
    expect(interest.byKind.find((k) => k.kind === "COMMENT")).toEqual({ kind: "COMMENT", events: 2, people: 1 });
    expect(interest.daysSinceLastEvent).toBe(3);
    expect(interest.weekly).toHaveLength(PROPERTY_VOICE_WEEKS);
    expect(interest.weekly[interest.weekly.length - 1].weekStart).toBe("2026-10-05");
    // Пустые недели остаются нулями, а не пропадают.
    expect(interest.weekly.every((w) => typeof w.events === "number")).toBe(true);
    expect(interest.weekly.reduce((s, w) => s + w.events, 0)).toBe(4);
  });

  it("без событий: нули и null, а не выдуманные числа", () => {
    const interest = foldInterest(baseRaw());
    expect(interest.events).toBe(0);
    expect(interest.lastEventAt).toBeNull();
    expect(interest.daysSinceLastEvent).toBeNull();
    expect(interest.exposures.clientSharedShare).toBeNull();
  });

  it("доля CLIENT_SHARED считается от экспозиций окна", () => {
    const sentAt = new Date(NOW.getTime() - DAY);
    const interest = foldInterest(
      baseRaw({
        exposures: [
          { kind: "PHOTO", sentAt, personKey: "WHATSAPP:1" },
          { kind: "LINK", sentAt, personKey: "WHATSAPP:1" },
          { kind: "CLIENT_SHARED", sentAt, personKey: "INSTAGRAM:2" },
          { kind: "CLIENT_SHARED", sentAt, personKey: "INSTAGRAM:3" },
          { kind: "PHOTO", sentAt: new Date(NOW.getTime() - 400 * DAY), personKey: "WHATSAPP:9" }, // вне окна
        ],
        conversationSources: [
          { source: "EXPOSURE", count: 3 },
          { source: "AD_REFERRAL", count: 1 },
        ],
      })
    );
    expect(interest.exposures.total).toBe(4);
    expect(interest.exposures.uniquePeople).toBe(3);
    expect(interest.exposures.clientShared).toBe(2);
    expect(interest.exposures.clientSharedShare).toBe(0.5);
    expect(interest.conversations.total).toBe(4);
    expect(interest.conversations.bySource[0].source).toBe("EXPOSURE");
  });
});

describe("комментарии", () => {
  it("частотные тексты берутся из ESCALATED, причины — из note", () => {
    const comments = foldComments([
      { channel: "INSTAGRAM", status: "ESCALATED", note: "нужен человек", text: "Торг возможен?", },
      { channel: "FACEBOOK", status: "ESCALATED", note: "нужен человек", text: "торг возможен" },
      { channel: "INSTAGRAM", status: "REPLIED", note: null, text: "Цена?" },
      { channel: "TELEGRAM", status: "HIDDEN", note: "spam", text: "купи крипту" },
    ]);
    // HIDDEN — шум, не голос клиента: в «Комментариев» не входит.
    expect(comments.total).toBe(3);
    expect(comments.escalated.count).toBe(2);
    expect(comments.escalated.topTexts).toEqual([{ text: "Торг возможен?", count: 2 }]);
    expect(comments.escalated.notes[0]).toEqual({ text: "нужен человек", count: 2 });
    expect(comments.byChannel.find((c) => c.channel === "INSTAGRAM")?.count).toBe(2);
  });
});

describe("комментарии: шум не считается голосом клиента", () => {
  const noise = ["SKIPPED", "DELETED", "HIDDEN", "PENDING", "WORKING", "FAILED"].map((status) => ({
    channel: "INSTAGRAM",
    status,
    note: "spam",
    text: "купи крипту",
  }));

  it("спам, конкурент и прочие нерезультативные статусы не попадают ни в total, ни в разбивки", () => {
    const comments = foldComments([...noise, { channel: "INSTAGRAM", status: "REPLIED", note: null, text: "Цена?" }]);
    expect(comments.total).toBe(1);
    expect(comments.byStatus).toEqual([{ status: "REPLIED", count: 1 }]);
    expect(comments.escalated.count).toBe(0);
  });

  it("одни спам-комментарии не маскируют «интереса нет»: диагноз видит ноль комментариев", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const raw = baseRaw({
      comments: noise,
      property: { id: "p1", price: 100_000, currency: "TJS", onSale: true, daysOnSale: 90 },
    });
    raw.now = now;
    const voice = foldPropertyVoice(raw);
    expect(voice.questions.comments.total).toBe(0);
    expect(voice.diagnosis.map((d) => d.code)).toContain("NO_INTEREST");
  });
});

describe("торг", () => {
  it("интерес до и после снижения цены; старое изменение — null, а не ложный ноль", () => {
    const cutAt = new Date(NOW.getTime() - 30 * DAY);
    const raw = baseRaw({
      interestEvents: [
        { kind: "SHARE_SENT", createdAt: new Date(cutAt.getTime() - 3 * DAY), personKey: "c:a" },
        { kind: "SHARE_SENT", createdAt: new Date(cutAt.getTime() + 2 * DAY), personKey: "c:b" },
        { kind: "SHARE_OPENED", createdAt: new Date(cutAt.getTime() + 5 * DAY), personKey: "c:c" },
        { kind: "SHARE_OPENED", createdAt: new Date(cutAt.getTime() + 20 * DAY), personKey: "c:d" }, // после окна 14 дней
      ],
      priceChanges: [
        { createdAt: cutAt, oldPrice: 100_000, newPrice: 90_000, oldCurrency: "TJS", newCurrency: "TJS" },
        {
          createdAt: new Date(NOW.getTime() - 400 * DAY),
          oldPrice: 120_000,
          newPrice: 100_000,
          oldCurrency: "TJS",
          newCurrency: "TJS",
        },
        { createdAt: new Date(NOW.getTime() - 2 * DAY), oldPrice: 100, newPrice: 90_000, oldCurrency: "USD", newCurrency: "TJS" },
      ],
    });
    const { priceChanges } = foldBargaining(raw);
    // Порядок — от свежего к старому.
    expect(priceChanges[0].oldCurrency).toBe("USD");
    expect(priceChanges[0].deltaPct).toBeNull(); // валюты разные — сравнивать нельзя
    expect(priceChanges[0].daysAfterObserved).toBe(2);
    const cut = priceChanges[1];
    expect(cut.deltaPct).toBe(-10);
    expect(cut.eventsBefore).toBe(1);
    expect(cut.eventsAfter).toBe(2);
    expect(cut.daysAfterObserved).toBe(14);
    const old = priceChanges[2];
    expect(old.eventsBefore).toBeNull();
    expect(old.eventsAfter).toBeNull();
  });

  it("сделка: скидка относительно цены в карточке, а при другой валюте — null", () => {
    const sold = new Date("2026-09-20T00:00:00Z");
    const raw = baseRaw({
      deals: [
        { stage: "COMPLETED", soldPrice: 92_000, currency: "TJS", closedAt: sold },
        { stage: "PENDING_APPROVAL", soldPrice: 9_000, currency: "USD", closedAt: null },
      ],
    });
    const { deals } = foldBargaining(raw);
    expect(deals[0].discountPct).toBe(-8);
    expect(deals[0].listPrice).toBe(100_000);
    expect(deals[0].listCurrency).toBe("TJS");
    expect(deals[1].discountPct).toBeNull();
    // Валюта цены в карточке отдаётся отдельно от валюты сделки: экран не подпишет её чужим значком.
    expect(deals[1]).toMatchObject({ currency: "USD", listCurrency: "TJS" });
  });

  it("цена скрыта правами (null) — скидки нет, сама сделка остаётся в ответе", () => {
    const raw = baseRaw({ deals: [{ stage: "COMPLETED", soldPrice: null, currency: "TJS", closedAt: null }], dealsOwnOnly: true });
    const bargaining = foldBargaining(raw);
    expect(bargaining.deals).toHaveLength(1);
    expect(bargaining.deals[0]).toMatchObject({ soldPrice: null, discountPct: null });
    expect(bargaining.dealsOwnOnly).toBe(true);
  });
});

describe("права: голос клиента после показа", () => {
  const feedbackCalls = [
    { outcome: "NOT_SUITABLE", outcomeLabel: "Не подошло", quote: "Двор шумный, звоните мне +992 900 12 34 56", summary: null, redFlags: [] },
    { outcome: "NOT_SUITABLE", outcomeLabel: "Не подошло", quote: null, summary: "Далеко от метро", redFlags: [] },
    { outcome: "AGENT_COMPLAINT", outcomeLabel: "Жалоба на сотрудника", quote: "грубил", summary: null, redFlags: ["agent_rude"] },
  ];

  it("директору раздел отдаётся: исходы, цитаты без телефонов, флаги", () => {
    const voice = foldPropertyVoice(baseRaw({ feedback: { calls: feedbackCalls } }));
    expect(voice.showingFeedback).toBeDefined();
    expect(voice.showingFeedback!.calls).toBe(3);
    expect(voice.showingFeedback!.byOutcome[0]).toEqual({ key: "NOT_SUITABLE", label: "Не подошло", count: 2 });
    expect(voice.showingFeedback!.quotes.join(" ")).not.toMatch(/900 12 34 56/);
    expect(voice.showingFeedback!.redFlags[0].text).toBe("agent_rude");
  });

  it("без права директора ключа showingFeedback в ответе нет вообще", () => {
    const voice = foldPropertyVoice(baseRaw({ feedback: null }));
    expect("showingFeedback" in voice).toBe(false);
    expect(JSON.stringify(voice)).not.toContain("showingFeedback");
  });

  it("свёртка опросов сама ничего не выдумывает на пустом входе", () => {
    expect(foldShowingFeedback([])).toEqual({ calls: 0, byOutcome: [], quotes: [], redFlags: [] });
  });
});

describe("полный ответ", () => {
  it("вопросы собственнику, показы, отказы и возражения из звонков", () => {
    const voice = foldPropertyVoice(
      baseRaw({
        ownerQuestions: [
          { question: "Торг возможен?", answer: "До 5%", askedAt: new Date(NOW.getTime() - 5 * DAY), answeredAt: new Date(NOW.getTime() - 4 * DAY) },
          { question: "Мебель остаётся?", answer: null, askedAt: new Date(NOW.getTime() - 2 * DAY), answeredAt: null },
        ],
        callObjections: [["дорого", "шумно"], ["Дорого"], []],
        showings: [
          { clientId: "a", type: "SHOWING", declinedAt: null, completedAt: new Date(NOW.getTime() - DAY), nextActionDate: null },
          { clientId: "a", type: "SHOWING", declinedAt: new Date(NOW.getTime() - DAY), completedAt: null, nextActionDate: null },
          { clientId: "b", type: "SHOWING", declinedAt: null, completedAt: null, nextActionDate: new Date(NOW.getTime() + 5 * DAY) },
        ],
        refusalReasons: ["EXPENSIVE", "EXPENSIVE", "WRONG_OBJECT", null],
        ads: {
          adsCount: 2,
          moneyHidden: false,
          spendTjs: 1200.5,
          spendOriginal: 100,
          currency: "USD",
          impressions: 5000,
          clicks: 120,
          conversations: 9,
          botConversations: 4,
        },
      })
    );
    expect(voice.questions.ownerQuestions).toMatchObject({ total: 2, answered: 1 });
    expect(voice.questions.ownerQuestions.items[0].question).toBe("Мебель остаётся?"); // свежие сверху
    expect(voice.questions.callObjections).toEqual({ calls: 3, top: [{ text: "дорого", count: 2 }, { text: "шумно", count: 1 }] });
    // Проведённый — только первый; отменённый и будущий не считаются.
    expect(voice.questions.showings).toEqual({ total: 3, conducted: 1, declined: 1, uniqueClients: 2 });
    expect(voice.questions.refusals.total).toBe(4);
    expect(voice.questions.refusals.byReason[0]).toMatchObject({ key: "EXPENSIVE", count: 2 });
    expect(voice.questions.refusals.byReason[0].label).toMatch(/Дорого/);
    expect(voice.ads).toMatchObject({ adsCount: 2, spendTjs: 1200.5, botConversations: 4 });
    expect(voice.windowDays).toBe(180);
  });
});

describe("объект звонка — только по доказательствам", () => {
  const none = { interactionPropertyId: null, matchedPropertyId: null, clientKind: "BUYER" as const, sellerPropertyIds: [] };

  it("приоритет: запись звонка → причина назначения лида → единственный объект продавца", () => {
    expect(pickProvenCallProperty({ ...none, interactionPropertyId: "i", matchedPropertyId: "m" })).toBe("i");
    expect(pickProvenCallProperty({ ...none, matchedPropertyId: "m" })).toBe("m");
    expect(pickProvenCallProperty({ ...none, clientKind: "SELLER", sellerPropertyIds: ["s"] })).toBe("s");
  });

  it("неоднозначность и отсутствие доказательств дают null, а не догадку", () => {
    expect(pickProvenCallProperty(none)).toBeNull();
    // Два объекта у продавца — какой из них в разговоре, неизвестно.
    expect(pickProvenCallProperty({ ...none, clientKind: "SELLER", sellerPropertyIds: ["s1", "s2"] })).toBeNull();
    // Покупатель с чужим единственным объектом продавца не связывается.
    expect(pickProvenCallProperty({ ...none, clientKind: "BUYER", sellerPropertyIds: ["s"] })).toBeNull();
  });
});

describe("мелочи привязки", () => {
  it("у Facebook id публикации сверяется и целиком, и без префикса страницы", () => {
    expect(commentMediaCandidates("FACEBOOK", "123_456")).toEqual(["123_456", "456"]);
    expect(commentMediaCandidates("INSTAGRAM", "178_90")).toEqual(["178_90"]);
  });

  it("отказ относится к показу только в окне свежести", () => {
    const start = refusalWindowStart(NOW);
    expect(NOW.getTime() - start.getTime()).toBe(SHOWING_REFUSAL_WINDOW_DAYS * DAY);
  });
});
