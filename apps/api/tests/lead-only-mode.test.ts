import { describe, expect, it } from "vitest";
import { leadOnlyAppliesTo, leadOnlyCallbackWhen, leadOnlyFilterReply, leadOnlyHotIntent, leadOnlyPhoneAskHistory, leadOnlyPhoneLine, leadOnlyReply,
  leadOnlyReplyAvoidingRepeat, leadOnlyScenario, clampMaxPhoneAsks, LEAD_ONLY_OFFICE_PHONE_TEXT } from "../src/ai/leadOnlyMode.js";
import { leadOnlyPropertyAsked } from "../src/lib/leadOnlySettings.js";

/**
 * Режим «только заявки» (владелец 12–13.11.2026): одна дверь решений и текстов
 * для обоих маршрутов бота. Здесь — сами решения; стык с ядром и старым путём —
 * в lead-only-mode-legacy-postgres.test.ts и lead-only-mode-core-postgres.test.ts.
 */
const config = { hotIntentHandover: true };
const soon = { kind: "soon" as const };

describe("горячие слова → агенту сразу", () => {
  it.each([
    "Хотим посмотреть квартиру",
    "мы хотели бы её посмотреть",
    "Можно посмотреть?",
    "Куда ехать?",
    "Скажите адрес, хотим завтра приехать",
    "Когда можно приехать?",
    "Мы реальные покупатели",
    "готовы купить",
    "Дидан мехоҳем",
    "дидан мехохем",
    "Куҷо биёем?",
    "кучо биём",
    "Кай омада метавонем?",
    "Суроғаш куҷо, пагоҳ биёем?",
    "Мо харидори воқеӣ ҳастем",
  ])("«%s» — горячие", text => {
    expect(leadOnlyHotIntent(text)).toBe(true);
    expect(leadOnlyScenario({ text, propertyKnown: false, config })).toBe("hot");
  });
  // Второе ревью 13.11: голый вопрос об адресе — вопрос об объекте, «другие варианты» — просьба о подборке.
  it.each(["Здравствуйте", "Сколько стоит?", "Адрес вашего офиса?", "Где ваш офис находится, адрес?", "Нархаш чанд?",
    "Скажите адрес", "Какой адрес?", "Суроғаш куҷо аст?", "Можно посмотреть другие варианты?", "Можно посмотреть ещё варианты?"])(
    "«%s» — не горячие", text => expect(leadOnlyHotIntent(text)).toBe(false));
  it("рубильник горячих слов выключен — сценарий не «hot»", () => {
    expect(leadOnlyScenario({ text: "Хотим посмотреть", propertyKnown: true, config: { hotIntentHandover: false } })).toBe("property");
  });
});

describe("сценарий хода", () => {
  it("продать квартиру — продавец", () => expect(leadOnlyScenario({ text: "Хочу продать свою квартиру", propertyKnown: false, config })).toBe("seller"));
  it("нужна квартира — покупатель", () => expect(leadOnlyScenario({ text: "Ищу двухкомнатную квартиру в Сино", propertyKnown: false, config })).toBe("buyer"));
  it("объект известен — сценарий объекта", () => expect(leadOnlyScenario({ text: "Интересует", propertyKnown: true, config })).toBe("property"));
  it("ясное «хочу продать» сильнее объекта в фокусе и слова «адрес»", () => {
    expect(leadOnlyScenario({ text: "Хочу продать свою квартиру", propertyKnown: true, config })).toBe("seller");
    expect(leadOnlyScenario({ text: "Продаю квартиру, адрес Сино 12", propertyKnown: false, config })).toBe("seller");
  });
  it("вакансии остаются как были (Ноза)", () => {
    expect(leadOnlyScenario({ text: "Есть вакансия? Ищу работу", propertyKnown: false, config })).toBeNull();
    expect(leadOnlyScenario({ text: "Хочу купить квартиру", propertyKnown: false, jobTopic: true, config })).toBeNull();
  });
  it("аренда и просто приветствие — не заявка", () => {
    expect(leadOnlyScenario({ text: "Сдаёте квартиру в аренду?", propertyKnown: false, config })).toBeNull();
    expect(leadOnlyScenario({ text: "Здравствуйте", propertyKnown: false, config })).toBeNull();
  });
});

describe("тексты", () => {
  const base = { sellerCommissionPercent: 2, when: soon };
  it("WhatsApp: номер не спрашиваем, звоним на этот номер", () => {
    const text = leadOnlyReply({ ...base, scenario: "seller", language: "ru", phone: { kind: "whatsapp" } });
    expect(text).toContain("на этот номер");
    expect(text).toContain("2%");
    expect(text).not.toMatch(/номер телефона|оставьте/i);
    const tg = leadOnlyReply({ ...base, scenario: "seller", language: "tg", phone: { kind: "whatsapp" } });
    expect(tg).toContain("ба ҳамин рақам");
    expect(tg).toContain("шумо");
  });
  it("Instagram: просим номер не больше заданного, потом офис один раз, потом молчим про номер", () => {
    const ask = (asksSoFar: number, officeAlreadyOffered = false) =>
      leadOnlyPhoneLine({ kind: "ask", asksSoFar, maxAsks: 2, officeAlreadyOffered }, soon, "ru");
    expect(ask(0)).toBe("Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    expect(ask(1)).toBe("Если удобно, напишите номер, и агент позвонит сам.");
    expect(ask(2)).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
    expect(ask(2, true)).toBeNull();
    expect(leadOnlyPhoneLine({ kind: "ask", asksSoFar: 1, maxAsks: 1, officeAlreadyOffered: false }, soon, "tg")).toContain("777 070 100");
  });
  it("счёт прежних просьб номера по своим репликам", () => {
    expect(leadOnlyPhoneAskHistory([
      "Да, есть варианты. Оставьте, пожалуйста, номер телефона, агент перезвонит.",
      "Какой номер телефона вы хотите оставить для связи?",
      "Здравствуйте!",
    ])).toEqual({ asksSoFar: 2, officeAlreadyOffered: false });
    expect(leadOnlyPhoneAskHistory([`Позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`]).officeAlreadyOffered).toBe(true);
  });
  it("вне рабочих часов честно: «утром с <начала>», а не «сейчас»", () => {
    expect(leadOnlyCallbackWhen({ now: "20:15", workHoursStart: "09:30", workHoursEnd: "18:00" })).toEqual({ kind: "tomorrow_from", from: "09:30" });
    expect(leadOnlyCallbackWhen({ now: "07:00", workHoursStart: "09:30", workHoursEnd: "18:00" })).toEqual({ kind: "today_from", from: "09:30" });
    expect(leadOnlyCallbackWhen({ now: "12:00", workHoursStart: "09:30", workHoursEnd: "18:00" })).toEqual({ kind: "soon" });
    const night = leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: { kind: "whatsapp" }, when: { kind: "tomorrow_from", from: "09:30" } });
    expect(night).toContain("завтра утром, с 09:30");
    expect(night).not.toMatch(/сейчас|скоро/i);
    const tg = leadOnlyReply({ ...base, scenario: "hot", language: "tg", phone: { kind: "given" }, when: { kind: "tomorrow_from", from: "09:30" } });
    expect(tg).toContain("пагоҳ саҳар аз соати 09:30");
  });
  it("сценарий 3: цифры только из базы, без данных — без цифр", () => {
    const withData = leadOnlyReply({ ...base, scenario: "buyer", language: "ru", phone: { kind: "whatsapp" },
      market: { districtName: "Сино", minPrice: "45000", currency: "USD" } });
    expect(withData).toContain("в районе Сино от 45 000 USD");
    const noData = leadOnlyReply({ ...base, scenario: "buyer", language: "ru", phone: { kind: "whatsapp" }, market: null });
    expect(noData).not.toMatch(/\d/);
  });
  it("сценарий 2: номер и цена объекта из базы; проданный — честно", () => {
    expect(leadOnlyReply({ ...base, scenario: "property", language: "ru", phone: { kind: "whatsapp" },
      property: { shortId: 192, price: "650000", currency: "TJS", sold: false } })).toContain("объект №192, цена 650 000 сомони");
    expect(leadOnlyReply({ ...base, scenario: "property", language: "ru", phone: { kind: "whatsapp" },
      property: { shortId: 192, price: null, currency: "TJS", sold: true } })).toContain("уже продан");
  });
  it("никаких длинных тире, ссылок и списков ни в одном тексте", () => {
    for (const scenario of ["hot", "property", "seller", "buyer", "escalate"] as const) {
      for (const language of ["ru", "tg"] as const) {
        for (const phone of [{ kind: "whatsapp" as const }, { kind: "given" as const }, { kind: "card" as const },
          { kind: "ask" as const, asksSoFar: 0, maxAsks: 2, officeAlreadyOffered: false }, { kind: "ask" as const, asksSoFar: 2, maxAsks: 2, officeAlreadyOffered: false }]) {
          const text = leadOnlyReply({ ...base, scenario, language, phone, property: { shortId: 7, price: "100", currency: "USD", sold: false },
            market: { districtName: null, minPrice: "100", currency: "USD" } });
          expect(text).not.toContain("—");
          expect(text).not.toMatch(/https?:|www\.|\n/);
          expect(text.length).toBeLessThan(220);
        }
      }
    }
  });
  it("предел просьб номера держится в 1..3", () => {
    expect(clampMaxPhoneAsks(0)).toBe(1); expect(clampMaxPhoneAsks(9)).toBe(3); expect(clampMaxPhoneAsks(undefined)).toBe(2);
  });
});

describe("второй слой запрета: фильтр ответа", () => {
  it("вырезает ссылки и подборку объектов", () => {
    const text = "Вот варианты:\n1. №12 Сино, 45 000 USD\n2. №15 Шохмансур, 50 000 USD\nhttps://royalhome.tj/listing/12\nАгент расскажет подробнее.";
    const out = leadOnlyFilterReply(text);
    expect(out.changed).toBe(true);
    expect(out.text).not.toMatch(/№12|№15|https/);
    expect(out.text).toContain("Агент расскажет подробнее.");
  });
  it("обычный короткий ответ и один объект по вопросу не трогает", () => {
    expect(leadOnlyFilterReply("Цена объекта №12: 45 000 USD.")).toEqual({ text: "Цена объекта №12: 45 000 USD.", changed: false });
    expect(leadOnlyFilterReply("Мы работаем с 9:30.").changed).toBe(false);
  });
});

// ── Ревью 13.11.2026: каждая правка — тест, который падает без неё ─────────────
describe("ревью 13.11: горячие слова не ловят отрицание и «посмотреть фото» (№13b)", () => {
  it.each(["Мы пока не готовы купить", "не готовы брать", "Нет, не хотим посмотреть", "Можно посмотреть фото?", "можно посмотреть видео квартиры",
    "Хотим посмотреть ещё фото"])("«%s» — не горячие", text => expect(leadOnlyHotIntent(text)).toBe(false));
  it.each(["Готовы купить, куда ехать?", "Можно её посмотреть завтра?"])("«%s» — по-прежнему горячие", text =>
    expect(leadOnlyHotIntent(text)).toBe(true));
});

describe("ревью 13.11: объект, оставшийся в фокусе, не «залипает» (№2)", () => {
  it.each(["Где ваш офис?", "Спасибо", "Здравствуйте", "А вы работаете в субботу?"])(
    "«%s» при старом объекте — не сценарий объекта", text =>
      expect(leadOnlyScenario({ text, propertyKnown: true, propertyInMessage: false, propertyAsked: leadOnlyPropertyAsked(text), config }))
        .not.toBe("property"));
  it("объект из этого сообщения или вопрос о нём — сценарий объекта", () => {
    expect(leadOnlyScenario({ text: "Салом", propertyKnown: true, propertyInMessage: true, config })).toBe("property");
    expect(leadOnlyScenario({ text: "Сколько стоит?", propertyKnown: true, propertyAsked: leadOnlyPropertyAsked("Сколько стоит?"), config })).toBe("property");
    expect(leadOnlyScenario({ text: "Эта квартира ещё продаётся?", propertyKnown: true, config })).toBe("property");
  });
  it("покупатель с новым запросом при старом объекте — покупатель, а не объект", () =>
    expect(leadOnlyScenario({ text: "Хочу купить квартиру в Сино", propertyKnown: true, config })).toBe("buyer"));
});

describe("ревью 13.11: правда в текстах (№3, №6)", () => {
  const base = { sellerCommissionPercent: 2, when: soon };
  const noPhone = (asksSoFar: number) => ({ kind: "ask" as const, asksSoFar, maxAsks: 2, officeAlreadyOffered: asksSoFar > 2 });
  it("без номера звонок не обещаем: покупатель и проданный объект", () => {
    const buyer = leadOnlyReply({ ...base, scenario: "buyer", language: "ru", phone: noPhone(3), market: { districtName: null, minPrice: "100", currency: "USD" } });
    expect(buyer).not.toMatch(/агент подберёт|позвонит|расскажет/i);
    const sold = leadOnlyReply({ ...base, scenario: "property", language: "ru", phone: noPhone(3), property: { shortId: 5, price: null, currency: "USD", sold: true } });
    expect(sold).toBe("Объект №5 уже продан.");
  });
  it("горячие слова без номера (заявки нет, никого не зовём): ни «передаю», ни «ответит здесь» — просьба номера, потом офис", () => {
    const first = leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: noPhone(0) });
    // Показ без заявки не обещаем (пятое ревью 13.11, №3): показ назначает агент.
    expect(first).toBe("Показ назначает агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    const text = leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: { kind: "ask", asksSoFar: 2, maxAsks: 2, officeAlreadyOffered: false } });
    expect(text).toBe(`Показ назначает агент. Если удобнее, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`);
    expect(text).not.toMatch(/передаю|ответит вам здесь|в курсе|Хорошо.*Хорошо/iu);
    expect(leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: noPhone(0), property: { shortId: 7, price: null, currency: "USD", sold: false } }))
      .toBe("Показ объекта №7 назначает агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
  });
  it("вопрос к сотруднику без номера — просьба номера, без «передаю»; с номером — «свяжется»; при заявке без звонка — «ответит здесь»", () => {
    expect(leadOnlyReply({ ...base, scenario: "escalate", language: "ru", phone: noPhone(0) }))
      .toBe("С этим вопросом поможет агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    // Просьбы исчерпаны, офис уже называли: номер офиса повторяется, а не одно «поможет агент» (пятое ревью 13.11, №3).
    expect(leadOnlyReply({ ...base, scenario: "escalate", language: "ru", phone: noPhone(3) })).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
    expect(leadOnlyReply({ ...base, scenario: "escalate", language: "tg", phone: { kind: "whatsapp" } })).toContain("тамос мегирад");
    // Номер WhatsApp есть, клиент просил не звонить: заявка заведена, агент правда ответит в переписке.
    expect(leadOnlyReply({ ...base, scenario: "escalate", language: "ru", agentInformed: true,
      phone: { kind: "ask", asksSoFar: 0, maxAsks: 2, officeAlreadyOffered: false, refused: true } })).toBe("Передаю ваш вопрос агенту, он ответит вам здесь.");
  });
  it("карточка есть, номер в этом ходе не давали — без «номер получил» (№6)", () => {
    const text = leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: { kind: "card" } });
    expect(text).not.toMatch(/номер получил/i);
    expect(text).toContain("Агент скоро позвонит вам.");
  });
});

describe("ревью 13.11: ответ не повторяется дословно и не бывает пустым", () => {
  const input = { sellerCommissionPercent: 2, when: soon, scenario: "hot" as const, language: "ru" as const, phone: { kind: "whatsapp" as const } };
  it("второй раз — другая строка, и так до короткого «понял»; пустым не бывает", () => {
    const sent: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const text = leadOnlyReplyAvoidingRepeat(input, sent);
      expect(text.trim()).not.toBe("");
      if (i < 5) expect(seen.has(text)).toBe(false);
      seen.add(text); sent.push(text);
    }
  });
});

describe("ревью 13.11: фильтр и каналы", () => {
  it("схлопнутые пустые строки — не изменение (№13c)", () => {
    expect(leadOnlyFilterReply("Здравствуйте!\n\n\n\nЧем помочь?").changed).toBe(false);
  });
  it("режим только для WhatsApp, Instagram и Facebook: сайт и Telegram — прежние (№11)", () => {
    expect(["WHATSAPP", "INSTAGRAM", "FACEBOOK"].every(leadOnlyAppliesTo)).toBe(true);
    expect(["WEBSITE", "TELEGRAM", undefined, null, ""].some(channel => leadOnlyAppliesTo(channel))).toBe(false);
  });
});
