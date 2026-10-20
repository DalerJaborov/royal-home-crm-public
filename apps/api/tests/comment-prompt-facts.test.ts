import { describe, expect, it } from "vitest";
import { AGENCY_COMPANY_INFO, AGENCY_LANGUAGE_RULES, SCENARIO_SELL } from "../src/ai/leadQualifier.js";
import { SALES_FACTS } from "../src/ai/salesPlaybook.js";
import { MANDATORY_BOT_RULES } from "../src/ai/dushanbeGeography.js";
import { COMMENT_SCENARIO_RULES, LANGUAGE_RULES as COMMENT_LANGUAGE_RULES } from "../src/messengers/comments.js";
import { describeProperty } from "../src/messengers/sharedMedia.js";

/**
 * Правила бота по итогам разметки владельца 17.09.2026 (docs/TASKS.md, ветка
 * fix/bot-rules-from-review-17-09): владелец разметил 21 сгенерированный ответ и
 * 32 настоящих ответа бота из переписок и комментариев.
 *
 * ГЛАВНАЯ НАХОДКА: в промте комментариев (comments.ts) не было фактов агентства —
 * они добавлялись только для YouTube (YOUTUBE_NO_DM_LINE), Instagram/Facebook их
 * не видели вовсе. Отсюда бот предлагал варианты аренды под постом и не отказывал
 * другим городам. С 17.09.2026 AGENCY_COMPANY_INFO + SALES_FACTS + новый блок
 * COMMENT_SCENARIO_RULES идут в systemStable для ЛЮБОГО канала (см.
 * decideOnComment в comments.ts) — тест стережёт именно этот набор строкой, а не
 * через buildCommentSystem (в него факты агентства не входят, они отдельным
 * параметром systemStable).
 */

const COMMENT_SYSTEM_STABLE = AGENCY_COMPANY_INFO + SALES_FACTS + COMMENT_SCENARIO_RULES;

describe("факты агентства в промте комментариев (все каналы, не только YouTube)", () => {
  it("аренды нет", () => {
    expect(COMMENT_SYSTEM_STABLE).toContain("АРЕНДЫ СЕЙЧАС НЕТ");
  });

  it("работаем только по Душанбе", () => {
    expect(COMMENT_SYSTEM_STABLE).toContain("Душанбе");
  });

  it("комиссия 2 процента упомянута", () => {
    expect(COMMENT_SYSTEM_STABLE).toContain("2 процента");
  });
});

describe("сценарии под постом (владелец 17.09.2026)", () => {
  it("аренда — без сбора номера и без директа", () => {
    expect(COMMENT_SCENARIO_RULES).toContain("Номер телефона НЕ проси");
  });

  it("другой город — отказ сразу, без «баррасӣ мекунем»", () => {
    expect(COMMENT_SCENARIO_RULES).toContain("ЗАПРЕЩЕНО «баррасӣ мекунем»");
  });

  it("продавец распознаётся отдельным сценарием", () => {
    expect(COMMENT_SCENARIO_RULES).toContain("ПРОДАВЕЦ");
  });

  it("двусмысленный запрос «квартира нужна» уточняется одним вопросом", () => {
    expect(COMMENT_SCENARIO_RULES).toContain("Харид ё иҷора?");
  });
});

describe("запрещённые слова совпадают в обоих промтах", () => {
  const forbidden = ["бидонед", "равон кунем", "мушаххас кунед", "бо камоли майл", "бо ҷону дил"];

  it.each(forbidden)("%s запрещено в переписке (leadQualifier)", (word) => {
    expect(AGENCY_LANGUAGE_RULES).toContain(word);
  });

  it.each(forbidden)("%s запрещено в комментариях", (word) => {
    expect(COMMENT_LANGUAGE_RULES).toContain(word);
  });

  it("«баррасӣ мекунем» усилено до полного запрета в переписке", () => {
    expect(AGENCY_LANGUAGE_RULES).toContain("вообще не употреблять");
  });
});

describe("другой город РТ в переписке (продавец) — отказ без «можем рассмотреть»", () => {
  it("фраза «баррасӣ кунем»/«можем рассмотреть» убрана из сценария продажи", () => {
    expect(SCENARIO_SELL).not.toContain("баррасӣ кунем");
    expect(SCENARIO_SELL).not.toContain("можем рассмотреть");
  });

  it("вместо этого — вежливый отказ сразу", () => {
    expect(SCENARIO_SELL).toContain("ОТКАЖИ ВЕЖЛИВО И СРАЗУ");
  });
});

describe("обращение к клиенту — только по имени, не по фамилии", () => {
  it("правило добавлено в карту обязательных правил", () => {
    expect(MANDATORY_BOT_RULES).toContain("ПО ФАМИЛИИ НЕ ОБРАЩАЙСЯ НИКОГДА");
  });
});

describe("тип дома объекта в описании (новостройка/вторичка/котлован)", () => {
  const base = {
    rooms: 2,
    type: "APARTMENT" as const,
    areaSqm: 54,
    price: 41000,
    currency: "USD",
    status: "AVAILABLE",
    district: { name: "Сино" },
    shortId: 123,
  };

  it("указывает тип рынка, когда он известен", () => {
    expect(describeProperty({ ...base, marketType: "NEW_BUILD" })).toContain("Новостройки");
    expect(describeProperty({ ...base, marketType: "SECONDARY" })).toContain("Вторичка");
  });

  it("не выдумывает тип рынка, когда его нет в карточке", () => {
    const text = describeProperty({ ...base, marketType: null });
    expect(text).not.toContain("Новостройки");
    expect(text).not.toContain("Вторичка");
    expect(text).not.toContain("Котлован");
  });
});
