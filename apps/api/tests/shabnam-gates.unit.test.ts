import { describe, expect, it } from "vitest";

/**
 * ШАБНАМ: МОДЕЛЬ ПОНИМАЕТ, А КОД РЕШАЛ ПО УЗКОМУ СПИСКУ ФРАЗ (аудит 14.11.2026).
 *
 * Чистые проверки без базы: быстрые пути на регулярках (код Google Authenticator,
 * вход и выход из мастера объекта, «не присылай мне такое») и строка канала в
 * промте. Перефразы — по-русски, по-таджикски и латиницей, плюс отрицательные
 * случаи: каждая фраза, которую быстрый путь НЕ должен забрать.
 */

const { parseStepUpCode } = await import("../src/telegram/assistantStepUp.js");
const { draftPhraseForTests } = await import("../src/telegram/assistantPropertyDraft.js");
const { parseNoticeIntent } = await import("../src/telegram/staffNotice.js");
const { assistantChannelGuide } = await import("../src/ai/assistant/promptSections.js");

describe("код Google Authenticator — любая запись шести цифр", () => {
  it.each([
    ["123456", "123456"],
    ["123 456", "123456"],
    ["12 34 56", "123456"],
    ["123-456", "123456"],
    ["123 456", "123456"],
    ["Код: 123456", "123456"],
    ["код 123 456", "123456"],
    ["мой код 123456", "123456"],
    ["вот код: 12-34-56", "123456"],
    ["коди ман 654321", "654321"],
    ["Kod: 654 321", "654321"],
    ["code 654321.", "654321"],
    ["«123456»", "123456"],
    ["١٢٣٤٥٦", "123456"], // арабско-индийские
    ["۱۲۳ ۴۵۶", "123456"], // персидские
    ["１２３４５６", "123456"], // полноширинные
  ])("«%s» → %s", (text, code) => {
    expect(parseStepUpCode(text)).toBe(code);
  });

  it.each([
    "мой пароль qwerty123",
    "код 123456 и ещё",
    "ОБ-123456",
    "1234567",
    "12345",
    "+992 123456",
    "цена 150000",
    "123456 сомони",
    "позвони 123456",
    "123 456 789",
    "",
  ])("«%s» — не код", (text) => {
    expect(parseStepUpCode(text)).toBeNull();
  });

  it("пустое сообщение и длинная фраза — не код", () => {
    expect(parseStepUpCode(undefined)).toBeNull();
    expect(parseStepUpCode(`код 123456 ${"и ещё ".repeat(10)}`)).toBeNull();
  });
});

describe("мастер объекта: начало — фраза целиком", () => {
  it.each([
    "добавь объект",
    "хочу внести квартиру",
    "Новая квартира",
    "новый объект!",
    "давай добавим новый дом",
    "внеси участок",
    "нужно завести коммерцию",
    "хонаи нав илова кунам",
    "объекти нав",
    "мехоҳам хона илова кунам",
    "квартира илова кунед",
    "/new_property",
  ])("«%s» — начать мастер", (text) => {
    expect(draftPhraseForTests(text)).toBe("start");
  });

  it.each([
    "новая квартира в Сино до 50 000?",
    "добавь объект в подборку Азизу",
    "квартира",
    "хочу квартиру",
    "есть новая квартира у Азиза",
  ])("«%s» — не начало", (text) => {
    expect(draftPhraseForTests(text)).not.toBe("start");
  });
});

describe("мастер объекта: выход словами", () => {
  it.each([
    "отмени", "Отмена", "не надо", "хватит", "стоп", "давай потом", "Ладно, потом", "выход", "выйти из черновика",
    "баромадан", "бекор кун", "бекор", "лозим нест", "баъдтар", "передумал", "cancel",
  ])("«%s» — выйти", (text) => {
    expect(draftPhraseForTests(text)).toBe("exit");
  });

  it.each([
    "отмени показ завтра",
    "не надо ремонт указывать, ремонт средний",
    "потом этаж 5",
    "хватит денег на ремонт",
    "3 комнаты, 5 этаж, Сино",
  ])("«%s» — не выход", (text) => {
    expect(draftPhraseForTests(text)).not.toBe("exit");
  });
});

describe("мастер объекта: явный вопрос о другом уходит помощнице", () => {
  it.each([
    "снизь цену ОБ-123",
    "ОБ-000088 сколько стоит?",
    "найди клиента Азиза",
    "покажи мои задачи",
    "покажи клиентов на сегодня",
    "напомни завтра позвонить",
    "ПР-456 перезвонил?",
    "ҷустуҷӯ кун мизоҷ Азиз",
  ])("«%s» — помощнице", (text) => {
    expect(draftPhraseForTests(text)).toBe("other");
  });

  it.each([
    "3 комнаты, 5 этаж, Сино",
    "цена 50000 долларов",
    "Этаж: 5",
    "покажи черновик",
    "Адрес: Рудаки 45",
    "продавец Азиз, ремонт хороший",
    "се ҳуҷра, ошёнаи 5",
  ])("«%s» — данные объекта (решает модель или разбор полей)", (text) => {
    expect(draftPhraseForTests(text)).toBeNull();
  });
});

describe("«не присылай мне такое» — шире", () => {
  it.each([
    ["перестань присылать оплаты", "payment", true],
    ["прекрати присылать задачи", "task", true],
    ["не беспокой по оплатам", "payment", true],
    ["не беспокойте меня по показам", "showing", true],
    ["эти уведомления мне не нужны", null, true],
    ["оплаты мне больше не нужны", "payment", true],
    ["уведомления об оплатах мне не нужны", "payment", true],
    ["ин паёмҳо ба ман даркор нест", null, true],
    ["пардохтро хомӯш кун", "payment", false],
    ["инро хомӯш кун", null, false],
  ] as const)("«%s» → выключить %s", (text, kind, explicit) => {
    expect(parseNoticeIntent(text)).toEqual({ type: "mute", kind, explicit });
  });

  it.each([
    "перестань присылать заявки Нозе",
    "не беспокой клиента",
    "клиенты мне не нужны",
    "квартира мне не нужна",
    "мне не нужно",
    "чароғро хомӯш кун",
    "не надо писать задачу на завтра",
    "объектро хомӯш кун",
  ])("«%s» — не про уведомления", (text) => {
    expect(parseNoticeIntent(text)).toBeNull();
  });
});

describe("строка канала в промте", () => {
  const actor = (surface?: "crm-private" | "telegram-private" | "telegram-group") => ({
    id: "a", role: "DIRECTOR", surface, canViewAllClients: true, canViewPhone: true, canViewReports: true, canViewFinance: true,
    canViewAllDeals: true, canAssignClients: true, canEditForeignProperties: true, canModerate: true, canRequestChange: true,
  });

  it("в группе деньги и сотрудники скрыты — «напишите в личку», а не «нет доступа»", () => {
    const line = assistantChannelGuide(actor("telegram-group"));
    expect(line).toMatch(/общая группа/);
    expect(line).toMatch(/расходы/);
    expect(line).toMatch(/в личку/);
    expect(line).toMatch(/паёми шахсӣ/);
    expect(line).toMatch(/не говори вовсе/);
  });

  it("в личке Telegram и в CRM — «нет доступа» только по списку разделов или отказу инструмента", () => {
    for (const surface of ["telegram-private", "crm-private", undefined] as const) {
      const line = assistantChannelGuide(actor(surface));
      expect(line).toMatch(/раздела нет в списке выше или инструмент сам вернул такой отказ/);
      expect(line).not.toMatch(/общая группа/);
    }
    expect(assistantChannelGuide(actor("telegram-private"))).toMatch(/Google Authenticator/);
  });
});
