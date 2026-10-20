import { describe, expect, it } from "vitest";
import { decideLeadKind, isOtherCityReason } from "../src/ai/leadKind.js";
import { mergeDraft, SCENARIO_SELL, type LeadDraft, type QualifyResult } from "../src/ai/leadQualifier.js";
import { COMMENT_SCENARIO_RULES } from "../src/messengers/comments.js";
import { otherCityAcceptedReply, otherInquiryAcceptedReply } from "../src/messengers/conversation.js";

/**
 * ДРУГОЙ ГОРОД — ЧЕСТНО ПРИНЯТЬ, НИЧЕГО НЕ ОБЕЩАТЬ (решение владельца 17.09.2026,
 * дословно: «номер принять можно, но НЕ обещать, что агент позвонит — зачем
 * обещать? Передать в „прочие“, это должен видеть директор»).
 *
 * ЖИВОЙ БАГ, НАЙДЕННЫЙ ПРИ РАЗБОРЕ. Промт SCENARIO_SELL и так запрещал обещания
 * («баррасӣ мекунем» и т.п.), но locationOutsideDushanbe переводил leadDraft.stage
 * в "awaiting_phone" — ту же стадию, что у обычного покупателя, — и код
 * ensurePhoneAskKept (ai/leadQualifier.ts) дописывал в отказ ровно запрещённое
 * обещание звонка (phoneReminder, ai/replyGuards.ts: «агенти мо бо Шумо тамос
 * мегирад» / «специалист свяжется с вами»). Отдельно от этого общий путь приёма
 * заявки (messengers/conversation.ts::acceptLead) всегда закрывал разговор фразой
 * «скажи, что агент скоро свяжется» — тоже обещанием, которого для «прочего
 * обращения» без агента никто не выполнит. Обе дыры проверяются здесь кодом, а не
 * только текстом промта (промт — это просьба, не гарантия).
 */

const PROMISE_WORDS = /занг мезанад|тамос мегирад|свяж(е[тм]ся|ется)|позвонит/iu;

describe("mergeDraft — другой город РТ не переводит стадию в awaiting_phone", () => {
  it("locationOutsideDushanbe оставляет stage=chatting (без него ensurePhoneAskKept дописал бы обещание звонка)", () => {
    const draft: LeadDraft = { stage: "chatting" };
    const result: QualifyResult = { reply: ["ok"], ready: true, intent: "sell", lead: { locationOutsideDushanbe: true } };
    expect(mergeDraft(draft, result).stage).toBe("chatting");
  });

  it("обычный продавец в Душанбе по-прежнему уходит в awaiting_phone", () => {
    const draft: LeadDraft = { stage: "chatting" };
    const result: QualifyResult = { reply: ["ok"], ready: true, intent: "sell", lead: {} };
    expect(mergeDraft(draft, result).stage).toBe("awaiting_phone");
  });
});

describe("isOtherCityReason — распознаёт оба источника причины «другой город»", () => {
  it("код-отсечка по словам клиента (coverageGuard)", () => {
    const decision = decideLeadKind({ intent: "buy", confident: true, clientText: "дар Бохтар хона мехарам" });
    expect(decision.reason).toMatch(/^другой город \(/);
    expect(isOtherCityReason(decision.reason)).toBe(true);
  });

  it("поле модели у продавца (locationOutsideDushanbe)", () => {
    const decision = decideLeadKind({ intent: "sell", confident: true, clientText: "хонаро дар Ҳисор мефурӯшам", locationOutsideDushanbe: true });
    // coverageGuard уже ловит «Ҳисор» в словах клиента и выигрывает по порядку
    // проверок — оба источника сводятся к одной и той же классификации.
    expect(isOtherCityReason(decision.reason)).toBe(true);
  });

  it("объект вне Душанбе без упоминания конкретного города в словах клиента", () => {
    const decision = decideLeadKind({ intent: "sell", confident: true, clientText: "хонаро мефурӯшам", locationOutsideDushanbe: true });
    expect(decision.reason).toBe("объект вне Душанбе");
    expect(isOtherCityReason(decision.reason)).toBe(true);
  });

  it("другие причины «прочего» не задеты (работа, аренда, услуги)", () => {
    expect(isOtherCityReason("работа")).toBe(false);
    expect(isOtherCityReason("аренда")).toBe(false);
    expect(isOtherCityReason(undefined)).toBe(false);
  });
});

describe("otherCityAcceptedReply — честный ответ без обещания звонка", () => {
  it("русский вариант — точная формулировка владельца, без обещаний", () => {
    const text = otherCityAcceptedReply("ru");
    expect(text).toBe("Записали, спасибо. Пока работаем только по Душанбе; если начнём работать в вашем городе — напишем.");
    expect(text).not.toMatch(PROMISE_WORDS);
  });

  it("таджикский вариант — точная формулировка владельца, без обещаний", () => {
    const text = otherCityAcceptedReply("tg");
    expect(text).toBe("Сабт кардем, раҳмат. Ҳоло танҳо дар Душанбе кор мекунем; агар дар шаҳри шумо сар кунем, менависем.");
    expect(text).not.toMatch(PROMISE_WORDS);
  });

  it("смешанный/неизвестный язык тоже без обещаний (таджикский по умолчанию)", () => {
    expect(otherCityAcceptedReply("mixed")).not.toMatch(PROMISE_WORDS);
    expect(otherCityAcceptedReply("unknown")).not.toMatch(PROMISE_WORDS);
  });
});

/**
 * ДОРАЗБОР 17.09.2026 (тот же день): «агент скоро свяжется» уходил не только по
 * другому городу, а ЛЮБОМУ kind=OTHER — электрику, продавцу участка, рекламе без
 * слов клиента. Правило владельца обобщено: обещания звонка нет ни для одной
 * причины «прочего обращения», раз агент этой заявке не назначается вообще.
 */
describe("otherInquiryAcceptedReply — общий нейтральный ответ для ЛЮБОГО kind=OTHER", () => {
  it("русский вариант — нейтральная формулировка владельца, без обещаний", () => {
    const text = otherInquiryAcceptedReply("ru");
    expect(text).toBe("Записали, спасибо. Если сможем помочь — напишем.");
    expect(text).not.toMatch(PROMISE_WORDS);
  });

  it("таджикский вариант — нейтральная формулировка владельца, без обещаний", () => {
    const text = otherInquiryAcceptedReply("tg");
    expect(text).toBe("Сабт кардем, раҳмат. Агар кӯмак карда тавонем, менависем.");
    expect(text).not.toMatch(PROMISE_WORDS);
  });

  it("смешанный/неизвестный язык тоже без обещаний", () => {
    expect(otherInquiryAcceptedReply("mixed")).not.toMatch(PROMISE_WORDS);
    expect(otherInquiryAcceptedReply("unknown")).not.toMatch(PROMISE_WORDS);
  });

  it("другого города и общей нейтральной причины — разные фразы (город честно упоминает Душанбе)", () => {
    expect(otherInquiryAcceptedReply("ru")).not.toBe(otherCityAcceptedReply("ru"));
  });
});

/**
 * «РАБОТА» (вакансия) СВОЮ ЛОГИКУ НЕ МЕНЯЕТ (#454/#455) — decideLeadKind по-прежнему
 * различает работу от прочих причин, и isOtherCityReason её не подхватывает. Сама
 * ветка вакансии в acceptLead (messengers/conversation.ts) возвращает результат
 * ДО вычисления kind/otherCity — новый общий путь физически не может её задеть,
 * но decideLeadKind — общая точка входа для обоих механизмов, и её поведение для
 * intent=job проверяется здесь как граница между ними.
 */
describe("вакансия (intent=job) — вне нового общего правила OTHER", () => {
  it("decideLeadKind классифицирует работу отдельной причиной, не «другим городом»", () => {
    const decision = decideLeadKind({ intent: "job", confident: true, clientText: "хочу работать агентом у вас" });
    expect(decision.kind).toBe("OTHER");
    expect(decision.reason).toBe("работа");
    expect(isOtherCityReason(decision.reason)).toBe(false);
  });
});

describe("промты: одна формулировка на обеих поверхностях (переписка и комментарии)", () => {
  it("SCENARIO_SELL прямо запрещает обещание звонка и содержит честную фразу", () => {
    expect(SCENARIO_SELL).toMatch(/ЗАПРЕЩЕНО ЛЮБОЕ ОБЕЩАНИЕ ЗВОНКА/);
    expect(SCENARIO_SELL).toContain("Записали, спасибо. Пока работаем только по Душанбе");
    expect(SCENARIO_SELL).toContain("Сабт кардем, раҳмат. Ҳоло танҳо дар Душанбе кор мекунем");
  });

  it("COMMENT_SCENARIO_RULES запрещает то же самое и той же фразой", () => {
    expect(COMMENT_SCENARIO_RULES).toMatch(/ЗАПРЕЩЕНО ЛЮБОЕ ОБЕЩАНИЕ/);
    expect(COMMENT_SCENARIO_RULES).toContain("Записали, спасибо. Пока работаем только по Душанбе");
    expect(COMMENT_SCENARIO_RULES).toContain("Сабт кардем, раҳмат. Ҳоло танҳо дар Душанбе кор мекунем");
  });

});
