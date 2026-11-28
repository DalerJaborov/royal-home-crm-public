import { describe, expect, it, vi } from "vitest";
import type { RecruitmentPosition } from "@royal-home/shared";

// Живых вызовов модели нет: транспорт режима (callAiText) подменён, остальное в модуле — настоящее (audit:mocks).
const callAiText = vi.fn(async (): Promise<unknown> => { throw new Error("нет ключа на стенде"); });
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText }));

const { understandFallback, understandTurn, understandingFromModel, operatorCallbackRange, OPERATOR_UNDERSTAND_ENDPOINT } =
  await import("../src/ai/operator/understand.js");
const { initialOperatorState } = await import("../src/ai/operator/decide.js");
const { runOperatorTurn } = await import("../src/ai/operator/index.js");
const { serializeOperatorState } = await import("../src/ai/operator/state.js");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;

/**
 * ОПЕРАТОР — ПОНЯТЬ ХОД. Запасные правила на живых фразах из таблицы SPEC.md (модель лежит), проверка ответа модели
 * кодом (цитаты, место вне Душанбе, время звонка, запреты владельца) и одна дверь runOperatorTurn целиком.
 */
const MANAGER: RecruitmentPosition = { key: "sales-manager", revision: 1, titleRu: "менеджер по продажам", titleTg: "менеҷери фурӯш",
  detailsRu: "", detailsTg: "", isOpen: true, keywords: ["менеджер"], postCodes: [] };
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: false, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2,
  vacancies: { open: [MANAGER], contactPhone: "+992 00 000 00 01" }, brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over });
const fb = (current: string, attachments?: Parameters<typeof understandFallback>[0]["attachments"]) =>
  understandFallback({ current, ...(attachments ? { attachments } : {}) }, initialOperatorState(), ctx());

describe("запасные правила на живых фразах SPEC.md", () => {
  it.each([
    ["Сколько стоят ваши услуги?", { question: "fee", role: null, language: "ru" }],
    ["Хочу продать квартиру", { role: "seller", language: "ru" }],
    ["Продать недвижимость", { role: "seller" }],
    ["Мехоҳам хонаамро фурӯшам", { role: "seller", language: "tg" }],
    ["Я хочу продоват свою квартиру", { role: "seller" }],
    ["мы хотим сдать дом, 3 комнаты", { role: "rent" }],
    ["Вакансия SMM-специалиста ещё актуальна?", { role: "job" }],
    ["Хизматрасониятонро қимматтар??", { question: "fee", language: "tg" }],
    ["Сколько стоить эта квартира", { aboutThisProperty: true, question: "property_price" }],
    ["Хочу купить 2-комнатную в Сино до 60 000$", { role: "buyer", hasDetails: true }],
  ] as const)("«%s»", (text, expected) => {
    expect(fb(text)).toMatchObject({ source: "fallback", ...expected });
  });

  it("«С 11 до 2.30 удобно» → «с 11:00 до 14:30»; таджикский вид «аз … то …»", () => {
    // Часы не досчитываем (ревью #425): разобранное кодом время — словами клиента; operatorCallbackRange выше — прежний разбор.
    expect(fb("С 11 до 2.30 удобно").callback.when).toBe("с 11 до 2:30");
    expect(operatorCallbackRange("аз 9 то 13 занг занед", "tg")).toBe("аз 09:00 то 13:00");
    expect(operatorCallbackRange("звоните с 18 до 9", "ru")).toBeNull();
  });

  it("Р7: комнаты, этажи и суммы — не время звонка; без слова о звонке или времени — тоже нет", () => {
    for (const text of ["аз 2 то 3 хона", "с 1 до 5 этажа", "от 500 до 700 тысяч", "с 2 до 3 комнаты, позвоните", "с 11 до 14"]) {
      expect(operatorCallbackRange(text, "ru"), text).toBeNull();
      expect(fb(text).callback.when, text).toBeNull();
    }
    expect(operatorCallbackRange("позвоните с 11 до 14", "ru")).toBe("с 11:00 до 14:00");
  });

  it("«Салом», «Асалом, услугатон чихелияй?», «Бале», «Рахмат»: приветствие и вежливость решает код, язык не меняют", () => {
    expect(fb("Салом")).toMatchObject({ greeting: "salom", greetingOnly: true, language: null, languageHint: "tg", role: null });
    expect(fb("Асалом, услугатон чихелияй?")).toMatchObject({ greeting: "assalom", greetingOnly: false, role: null });
    expect(fb("Бале")).toMatchObject({ ackOnly: true, thanksOnly: false, language: null });
    expect(fb("Рахмат")).toMatchObject({ ackOnly: true, thanksOnly: true, language: null });
  });

  it("«Салом» + русский вопрос без предлогов — русский, не таджикский (разбор 23.11.2026, Б1)", () => {
    expect(fb("Салом, цена квартиры?")).toMatchObject({ greeting: "salom", language: "ru" });
    expect(fb("Салом, квартира ещё актуальна?")).toMatchObject({ greeting: "salom", language: "ru" });
    expect(fb("Салом. 3 комнатная квартира Сино цена?")).toMatchObject({ greeting: "salom", language: "ru" });
  });

  it("кнопка рекламы «Привет! Можно узнать об этом подробнее?» — не «этот объект» и язык не решает", () => {
    expect(fb("Привет! Можно узнать об этом подробнее?")).toMatchObject({ adOpener: true, aboutThisProperty: false, language: null });
  });

  it("звонок: «пишите в WhatsApp» — писать, «не звоните, я просто смотрю» — не звонить; номер — кодом", () => {
    expect(fb("Пишите в WhatsApp, не звоните").callback).toMatchObject({ textOnly: true, noCall: false });
    expect(fb("Не звоните мне, я просто смотрю").callback).toMatchObject({ textOnly: false, noCall: true });
    expect(fb("мой номер 93 555 12 34")).toMatchObject({ phone: "+992935551234", hasText: true, hasDetails: false });
  });

  it("место вне Душанбе: Гиссар — да, район Рудаки — нет", () => {
    expect(fb("Хона дар Гиссар").outsidePlace).toBe("Гиссар");
    expect(fb("Хона дар ноҳияи Рӯдакӣ").outsidePlace).toBeNull();
  });

  it("случаи 21–26: торг, грубость, «вы бот?», не по теме, жалоба", () => {
    expect(fb("Дорого. По-братски скидку сделаете?").bargain).toBe(true);
    expect(fb("вы что, дураки?").rude).toBe(true);
    expect(fb("Вы бот? Дайте живого человека").botQuestion).toBe(true);
    expect(fb("Подпишитесь на мой канал, взаимная подписка").offTopic).toBe(true);
    expect(fb("Мне никто так и не позвонил").complaint).toBe(true);
  });

  it("вложения — от сервера: голосовое не расшифровано и без слов — нет текста; вакансия ищется среди открытых", () => {
    expect(fb("", { voice: "failed" })).toMatchObject({ hasText: false, attachments: { voice: "failed" } });
    expect(fb("Нужен менеджер? Хочу на вакансию менеджера").job.openKey).toBe("sales-manager");
  });
});

describe("ответ модели проверяет код", () => {
  const answer = (over: Record<string, unknown> = {}) => ({ role: "none", roleQuote: "", question: "none", aboutThisProperty: false,
    rooms: "", district: "", budget: "", area: "", floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "",
    textOnly: false, noCall: false, language: "none", bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false,
    jobPosition: "", outsidePlace: "", ...over });
  const check = (current: string, raw: unknown, recent: Array<{ role: "user" | "assistant"; text: string }> = []) =>
    understandingFromModel(raw, { current, recent }, initialOperatorState(), ctx());

  it("модель понимает то, что запасные правила не видят: «Хонаи мо дар Ромит», «Не, ватсапда нависед», «Ту … нестӣ?»", () => {
    expect(check("Хонаи мо дар Ромит", answer({ outsidePlace: "Ромит", district: "Ромит", language: "tg" }))!.understanding)
      .toMatchObject({ outsidePlace: "Ромит", language: "tg", details: { district: "Ромит" } });
    expect(check("Не, ватсапда нависед", answer({ textOnly: true, language: "tg" }))!.understanding)
      .toMatchObject({ callback: { textOnly: true, noCall: false }, language: "tg" });
    expect(check("Ту Фаррух нестӣ?", answer({ question: "identity", language: "tg" }))!.understanding.question).toBe("identity");
  });

  it("роль без цитаты из слов клиента отброшена; цитата из прежних слов клиента засчитана", () => {
    const bad = check("Сколько вы берёте?", answer({ role: "seller", roleQuote: "продаю дом" }))!;
    expect(bad.rejected).toContain("role");
    expect(bad.understanding.role).toBeNull();
    const good = check("Сколько вы берёте?", answer({ role: "seller", roleQuote: "Продаю дом" }), [{ role: "user", text: "Продаю дом в Гипроземе" }])!;
    expect(good.understanding.role).toBe("seller");
  });

  it("запреты владельца — код поверх модели: вакансия и аренда", () => {
    expect(check("Вакансия SMM-специалиста ещё актуальна?", answer({ role: "buyer", roleQuote: "актуальна" }))!.understanding.role).toBe("job");
    expect(check("Хочу снять квартиру в Сино", answer({ role: "buyer", roleQuote: "квартиру в Сино" }))!.understanding.role).toBe("rent");
  });

  it("место «Рудаки» и место не из слов клиента отброшены; время звонка без цитаты отброшено", () => {
    expect(check("Хона дар ноҳияи Рӯдакӣ", answer({ outsidePlace: "Рӯдакӣ" }))!.understanding.outsidePlace).toBeNull();
    expect(check("Хона дар Сино", answer({ outsidePlace: "Вахдат" }))!.understanding.outsidePlace).toBeNull();
    const when = check("Позвоните после обеда", answer({ callbackWhen: "завтра в 10:00", callbackQuote: "завтра в 10" }))!;
    expect(when.rejected).toContain("callbackWhen");
    // Слова модели без цитаты отброшены; остаётся то, что код сам прочёл в словах клиента (25.11.2026, operatorCallbackTime).
    expect(when.understanding.callback.when).toBe("после обеда");
    expect(when.understanding.callback.time).toMatchObject({ day: null, part: "afternoon", clock: null, confident: true });
    const ok = check("С 11 до 2.30 удобно", answer({ callbackWhen: "с 11:00 до 14:30", callbackQuote: "С 11 до 2.30" }))!;
    // Часы не досчитываем (ревью #425): в заявку — время словами клиента, разобранное кодом.
    expect(ok.understanding.callback.when).toBe("с 11 до 2:30");
    // Р7: модель ответила «времени нет» — запасные правила её не перебивают.
    expect(check("С 11 до 2.30 удобно", answer())!.understanding.callback.when).toBeNull();
  });

  it("детали, которых нет в словах клиента, и должность не из его слов — отброшены", () => {
    const result = check("2 хонага, ремонт, 700 ҳазор", answer({ rooms: "2", budget: "700 ҳазор", district: "Сино", jobPosition: "директор" }))!;
    expect(result.understanding.details).toEqual({ rooms: "2", budget: "700 ҳазор" });
    expect(result.rejected).toEqual(expect.arrayContaining(["district", "jobPosition"]));
  });

  it("ответ не по схеме — null (тогда весь ход по запасным правилам)", () => {
    expect(check("Хочу продать", { role: "boss" })).toBeNull();
    expect(check("Хочу продать", null)).toBeNull();
  });
});

describe("understandTurn и одна дверь runOperatorTurn", () => {
  it("модель не ответила, вышла по сроку или ответила мусором — запасные правила, без исключения", async () => {
    const state = initialOperatorState();
    await expect(understandTurn({ current: "Хочу продать квартиру" }, state, ctx(), async () => { throw new Error("down"); }))
      .resolves.toMatchObject({ source: "fallback", role: "seller" });
    await expect(understandTurn({ current: "Хочу продать квартиру" }, state, ctx(), () => new Promise(() => {}), 20))
      .resolves.toMatchObject({ source: "fallback", role: "seller" });
    await expect(understandTurn({ current: "Хочу продать квартиру" }, state, ctx(), async () => ({ nonsense: true })))
      .resolves.toMatchObject({ source: "fallback" });
  });

  it("по умолчанию — общий транспорт режима (callAiText, своя точка журнала); номер без букв модель не зовёт", async () => {
    callAiText.mockClear();
    await expect(understandTurn({ current: "Хочу продать квартиру" }, initialOperatorState(), ctx())).resolves.toMatchObject({ source: "fallback" });
    expect(callAiText).toHaveBeenCalledTimes(1);
    expect(callAiText.mock.calls[0]![0]).toMatchObject({ endpoint: OPERATOR_UNDERSTAND_ENDPOINT, simple: true });
    callAiText.mockClear();
    await understandTurn({ current: "93 555 12 34" }, initialOperatorState(), ctx());
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("Р9: ход не собрался (фраза без переменной) — ошибка в журнал и запасной шаг «контакт», клиент не без ответа", async () => {
    const broken = ctx({ brandName: undefined as never });
    const model = async () => ({ role: "none", roleQuote: "", question: "identity", aboutThisProperty: false, rooms: "", district: "", budget: "",
      area: "", floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru",
      bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" });
    const result = await runOperatorTurn({ storedState: null, input: { current: "Вы кто? Это не Фаррух?" }, ctx: broken, model });
    expect(result.degraded).toBe(true);
    expect(result.text).toBe("Вы хотите купить или продать недвижимость?");
    const seller = await runOperatorTurn({ storedState: { ...serializeOperatorState({ ...initialOperatorState(), role: "seller" }) },
      input: { current: "Вы кто? Это не Фаррух?" }, ctx: broken, model });
    expect(seller.actions.map(a => a.type)).toEqual(["accept_lead"]);
    expect(seller.text).toBe("Спасибо, передаю агенту, он позвонит вам на этот номер WhatsApp.");
  });

  it("случай 3 через одну дверь: память переходит между ходами через jsonb, заявка одна, текст и шаги для compose", async () => {
    const model = async (request: { user: string }) => {
      const current = JSON.parse(request.user).currentClientMessage as string;
      return current.includes("продать")
        ? { role: "seller", roleQuote: "продать квартиру", question: "none", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "",
          floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "ru",
          bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" }
        : null;
    };
    const now = new Date("2026-11-19T10:00:00.000Z");
    const c = ctx({ ad: { topic: "seller", propertyId: null } });
    const first = await runOperatorTurn({ storedState: null, input: { current: "Хочу продать квартиру" }, ctx: c, now, model });
    // Владелец 22.11.2026: голая роль — сначала вопрос по сути, без заявки и без срока звонка.
    expect(first.text).toBe("Поможем с продажей, комиссия агентства 2%. Напишите, что продаёте и в каком районе, всё расскажем.");
    expect(first.steps.map(step => step.key)).toEqual(["seller_intro", "role_details_seller"]);
    expect(first.facts).toMatchObject({ percent: 2 });
    expect(first.actions.filter(a => a.type === "accept_lead")).toHaveLength(0);
    const second = await runOperatorTurn({ storedState: JSON.parse(JSON.stringify(first.stored)),
      input: { current: "Сино, 3 комнаты, 80 кв, 5 этаж, ремонт, 90 000$", recent: [{ role: "user", text: "Хочу продать квартиру" }, { role: "assistant", text: first.text! }] },
      ctx: c, now, model });
    expect(second.text).toBe("Спасибо, передаю агенту, он позвонит вам на этот номер WhatsApp.");
    expect(second.actions.filter(a => a.type === "accept_lead")).toHaveLength(1);
    const third = await runOperatorTurn({ storedState: second.stored, input: { current: "ок" }, ctx: { ...c, leadPending: true }, now, model });
    expect(third.text).toBeNull();
    expect(third.actions).toEqual([]);
  });
});
