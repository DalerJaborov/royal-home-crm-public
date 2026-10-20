import { afterAll, describe, expect, it } from "vitest";

/**
 * СТОРОЖ «ВНЕ ПОДБОРКИ» НА ДАННЫХ В ФОРМЕ ПРОДА (09.10.2026, аудит робота перед первым
 * клиентом, docs/robot-audit-2026-10-09-persona.md, P0-1, P1-1, P1-7).
 *
 * Прежние тесты кормили сторож ответами функций с ценой ЦИФРАМИ, а в проде функции
 * отдают цену, площадь и этаж СЛОВАМИ — тест был зелёным на данных, которых не бывает.
 * Здесь — точная форма ответов search_properties/get_property и обе формы расшифровки
 * речи робота (цифрами и словами).
 */

const { spokenNumbersToDigits } = await import("@royal-home/shared");
const {
  LiveVoiceReplyGuard,
  attachGuardFacts,
  extractAreaClaims,
  extractFloorClaims,
  offCatalogCorrectionText,
  offCatalogLogMessage,
  toolResultTranscriptLine,
  OFF_CATALOG_DEDUP_KEY,
} = await import("../src/lib/telephony/liveVoiceGuards.js");
const { logSystemError } = await import("../src/lib/systemError.js");
const { prisma } = await import("../src/db.js");

/** Ответ search_properties ровно в том виде, в каком его собирает liveVoicePropertyTools.ts. */
function prodSearchReply() {
  return attachGuardFacts(
    {
      ok: true,
      found: 1,
      options: [
        {
          number: 112,
          rooms: 2,
          where: "Сино, Айни, у Профсоюза",
          price: "сорок пять тысяч долларов",
          price_tjs: "четыреста девяносто тысяч сомони",
          area: "шестьдесят два с половиной квадрата",
          floor: "пятый этаж из девяти",
          market: "вторичка",
        },
      ],
      note: "Назови ОДИН вариант…",
    },
    [
      { price: 45_000, currency: "USD", areaSqm: 62.5, floor: 5, totalFloors: 9 },
      { price: 490_000, currency: "TJS", areaSqm: null, floor: null, totalFloors: null },
    ]
  );
}

const KNOWLEDGE = "<справочник>Карта мест: проспект Рудаки — центр, Сомони — район. Комиссия 2 %.</справочник>";

describe("числа словами → цифры (packages/shared/spokenNumber.ts)", () => {
  it("цены, площадь, бюджет в косвенном падеже, таджикский; цифры остаются как были", () => {
    expect(spokenNumbersToDigits("сорок пять тысяч долларов")).toBe("45000 долларов");
    expect(spokenNumbersToDigits("шестьдесят два с половиной квадрата")).toBe("62.5 квадрата");
    expect(spokenNumbersToDigits("до шестисот тысяч сомони")).toBe("до 600000 сомони");
    expect(spokenNumbersToDigits("восемьсот девяносто семь тысяч")).toBe("897000");
    expect(spokenNumbersToDigits("чил панҷ ҳазор доллар")).toBe("45000 доллар");
    expect(spokenNumbersToDigits("полтора миллиона")).toBe("1500000");
    expect(spokenNumbersToDigits("45 000 долларов")).toBe("45 000 долларов");
    expect(spokenNumbersToDigits("несколько тысяч долларов")).toBe("несколько тысяч долларов");
  });

  it("номер телефона по частям не склеивается в цену", () => {
    expect(spokenNumbersToDigits("девяносто три пятьсот пятьдесят пять")).toBe("93, 555");
  });

  it("площадь и этаж из текста, приведённого к цифрам; расстояние — не площадь", () => {
    expect(extractAreaClaims(spokenNumbersToDigits("шестьдесят два с половиной квадрата"))).toEqual([62.5]);
    expect(extractAreaClaims("87 м², а до метро 300 метров от дома, в 500 метрах школа")).toEqual([87]);
    expect(extractFloorClaims(spokenNumbersToDigits("пятый этаж из девяти"))).toEqual([5]);
    expect(extractFloorClaims(spokenNumbersToDigits("на двадцать пятом этаже"))).toEqual([25]);
    expect(extractFloorClaims("15 этаж, а ещё на 3-м этаже")).toEqual([15, 3]);
  });
});

describe("P0-1. Ответ функции в форме прода", () => {
  it("цена из подборки, расшифрованная ЦИФРАМИ, — не выдумка (раньше сторож считал её выдумкой и замолкал)", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", knowledgeText: KNOWLEDGE, usdToTjs: 10.9 });
    g.addToolResult(prodSearchReply());
    expect(g.onModelText("Есть двушка в Сино, на Айни, 62.5 квадрата, пятый этаж, за 45 тысяч долларов.")).toEqual([]);
  });

  it("та же цена СЛОВАМИ и сомони из готового price_tjs — не выдумка", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", knowledgeText: KNOWLEDGE, usdToTjs: 10.9 });
    g.addToolResult(prodSearchReply());
    expect(
      g.onModelText("Есть двушка на улице Айни, шестьдесят два с половиной квадрата, пятый этаж, сорок пять тысяч долларов, это четыреста девяносто тысяч сомони.")
    ).toEqual([]);
  });

  it("сырые числа скрытым полем: модель их не видит, сторож — видит", () => {
    const reply = attachGuardFacts({ ok: true, found: 1, options: [{ number: 7 }] }, [
      { price: 52_000, currency: "USD", areaSqm: 70, floor: 3, totalFloors: 12 },
    ]);
    expect(JSON.stringify(reply)).not.toContain("52000");
    expect({ ...reply }).not.toHaveProperty("facts");
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.addToolResult(reply);
    expect(g.onModelText("Есть квартира, семьдесят квадратов, третий этаж, пятьдесят две тысячи долларов.")).toEqual([]);
  });

  it("выдуманная цена СЛОВАМИ при пустой подборке — находка (раньше слов сторож не видел)", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", knowledgeText: KNOWLEDGE });
    g.addToolResult({ ok: true, found: 0, note: "ничего нет" });
    const [f] = g.onModelText("Есть двушка за восемьсот девяносто семь тысяч сомони.");
    expect(f).toMatchObject({ kind: "off_catalog" });
    expect((f as { prices: number[] }).prices).toContain(897_000);
  });

  it("улица из справочника (Рудаки) при found 0 — находка: справочник не источник улиц вариантов", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", knowledgeText: KNOWLEDGE });
    g.addToolResult({ ok: true, found: 0 });
    const [f] = g.onModelText("Есть двушка на проспекте Рудаки, хорошая.");
    expect(f).toMatchObject({ kind: "off_catalog", streets: ["Рудаки"] });
  });

  it("адрес офиса из справочника вне разговора об объекте — не находка", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", knowledgeText: KNOWLEDGE });
    expect(g.onModelText("Наш офис на проспекте Рудаки, приходите.")).toEqual([]);
  });

  it("площадь и этаж вне подборки — находка; из подборки словами — нет; вопрос клиенту — нет", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.addToolResult(prodSearchReply());
    expect(g.onModelText("Вам выше пятнадцатого этажа?")).toEqual([]);
    g.onTurnComplete();
    const [f] = g.onModelText("Есть ещё в Бофанде, восемьдесят семь квадратов, пятнадцатый этаж.");
    expect(f).toMatchObject({ kind: "off_catalog", areas: [87], floors: [15] });
  });

  it("каждая реплика: законная в первой, выдуманная во второй — находка во второй; повтор не плодится", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", usdToTjs: 10.9 });
    g.addToolResult(prodSearchReply());
    expect(g.onModelText("Есть двушка за сорок пять тысяч долларов.")).toEqual([]);
    g.onTurnComplete();
    const second = g.onModelText("А ещё одна за шестьдесят тысяч долларов.");
    expect(second).toHaveLength(1);
    expect((second[0] as { prices: number[] }).prices).toContain(60_000);
    g.onTurnComplete();
    expect(g.onModelText("Та, что за шестьдесят тысяч долларов, хорошая.")).toEqual([]);
  });

  it("находка несёт служебную поправку модели без рода и с просьбой не читать её вслух", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    const [f] = g.onModelText("Есть двушка на улице Ломоносова за 897 тыс. сомони.");
    const correction = (f as { correction: string }).correction;
    expect(correction).toContain("Служебное");
    expect(correction).toContain("вслух не читай");
    expect(correction).toContain("скажет агент");
    expect(correction).not.toMatch(/назвал\(а\)|назвала|назвал /);
  });
});

describe("P1-7. «Есть варианты» до поиска и процент скидки — кодом, как у чат-бота", () => {
  it("«есть отличные варианты» до search_properties — находка; после найденного — нет", () => {
    const before = new LiveVoiceReplyGuard({ language: "ru" });
    const [f] = before.onModelText("В этом бюджете у нас есть отличные варианты в Сино.");
    expect(f).toMatchObject({ kind: "off_catalog", noOptionsClaim: true });
    expect((f as { correction: string }).correction).toContain("search_properties");

    const after = new LiveVoiceReplyGuard({ language: "ru" });
    after.addToolResult(prodSearchReply());
    expect(after.onModelText("В этом бюджете у нас есть отличные варианты в Сино.")).toEqual([]);
  });

  it("«скидка десять процентов» словами — находка с поправкой про торг", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.addToolResult(prodSearchReply());
    const [f] = g.onModelText("Думаю, собственник сделает скидку десять процентов.");
    expect(f).toMatchObject({ kind: "off_catalog", discounts: [10] });
    expect((f as { correction: string }).correction).toContain("торг обсуждает агент");
  });
});

describe("P1-1. Видимость: строки расшифровки и журнал по звонку", () => {
  it("вызовы функций — строками без адресов и цен", () => {
    expect(toolResultTranscriptLine("search_properties", prodSearchReply())).toBe("[функция search_properties: найдено 1, номера 112]");
    expect(toolResultTranscriptLine("search_properties", { ok: true, found: 0 })).toBe("[функция search_properties: найдено 0]");
    expect(toolResultTranscriptLine("get_property", { ok: true, found: true, closed: true, number: 5 })).toBe("[функция get_property: закрытый, номер 5]");
    expect(toolResultTranscriptLine("transfer_to_agent", { ok: true, transferred_to: "Умед" })).toBe("[перевод: → Умед]");
    expect(toolResultTranscriptLine("save_contact", { ok: true })).toBeNull();
  });

  const scopeA = `lv-scope-a-${Date.now()}`;
  const scopeB = `lv-scope-b-${Date.now()}`;
  afterAll(async () => {
    await prisma.errorLog.deleteMany({ where: { dedupKey: OFF_CATALOG_DEDUP_KEY, message: { contains: "lv-scope-" } } });
  });

  it("dedupScope: два звонка за окно дедупа — две строки; повтор в том же звонке — одна", async () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    const [f] = g.onModelText("Есть двушка на улице Ломоносова за 897 тыс. сомони.");
    const finding = f as Parameters<typeof offCatalogLogMessage>[1];
    await logSystemError("telephony", offCatalogLogMessage(scopeA, finding), { dedupKey: OFF_CATALOG_DEDUP_KEY, dedupScope: scopeA });
    await logSystemError("telephony", offCatalogLogMessage(scopeA, finding), { dedupKey: OFF_CATALOG_DEDUP_KEY, dedupScope: scopeA });
    await logSystemError("telephony", offCatalogLogMessage(scopeB, finding), { dedupKey: OFF_CATALOG_DEDUP_KEY, dedupScope: scopeB });
    const rows = await prisma.errorLog.findMany({
      where: { dedupKey: OFF_CATALOG_DEDUP_KEY, OR: [{ message: { contains: scopeA } }, { message: { contains: scopeB } }] },
      select: { message: true },
    });
    expect(rows.filter((r) => r.message.includes(scopeA))).toHaveLength(1);
    expect(rows.filter((r) => r.message.includes(scopeB))).toHaveLength(1);
  });

  it("поправка про скидку и «варианты» — отдельными частями одной служебной реплики", () => {
    const text = offCatalogCorrectionText({ catalog: false, noOptions: true, discount: true });
    expect(text).toContain("search_properties");
    expect(text).toContain("скидки");
  });
});
