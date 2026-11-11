import { describe, expect, it } from "vitest";
import { buildInterviewInviteCallPrompt, INTERVIEW_INVITE_GREETING_TRIGGER } from "../src/ai/interviewInviteCallPersona.js";
import { buildPostShowingCallPrompt, POST_SHOWING_CALL_GREETING_TRIGGER } from "../src/ai/postShowingCallPersona.js";
import { buildSellerProbeCallPrompt, SELLER_PROBE_CALL_GREETING_TRIGGER } from "../src/ai/sellerProbeCallPersona.js";
import { buildLiveVoiceSystemPrompt, liveVoiceThirdPartyRule, LIVE_VOICE_NO_TIME_PROMISE_RULE } from "../src/ai/liveVoicePersona.js";
import { buildConsultantSystemPrompt } from "../src/ai/liveVoiceConsultantPersona.js";
import { findThirdPartyDisclosure, reportThirdPartyDisclosure } from "../src/ai/thirdPartyDisclosure.js";
import { findTimePromises } from "../src/ai/timePromiseGuard.js";
import { LiveVoiceReplyGuard } from "../src/lib/telephony/liveVoiceGuards.js";
import { consultantToolsFor, CONSULTANT_TOOLS } from "../src/lib/telephony/liveVoiceConsultant.js";
import { CLIENT_TOOLS, handleClientTool, missingRequestFields, parseDeclinedFields } from "../src/lib/telephony/liveVoiceClientTools.js";
import { newPropertyCallMemory } from "../src/lib/telephony/liveVoicePropertyTools.js";

/**
 * Три слабости робозвонка, найденные симуляциями ElevenLabs 11.11.2026: посторонний на линии,
 * сроки перезвона и показ мимо тумблера, неполное save_client_request. Правило проекта —
 * «запрет боту = промпт + фильтр в коде»: каждый пункт держится и текстом, и кодом.
 */

const INVITE_AT = new Date("2026-11-14T09:00:00Z");
const invite = (language: "ru" | "tg") => buildInterviewInviteCallPrompt({ candidateName: "Мехрона", interviewAt: INVITE_AT, address: null, language });
const post = () =>
  buildPostShowingCallPrompt({ clientName: "Фарход", propertyTitle: "2-комнатная в Сино", agentName: "Мадина", whenLabel: "вчера", voiceGender: "female" }, true);
const probe = () => buildSellerProbeCallPrompt({ sellerName: "Рустам", propertyLabel: "двухкомнатную на Сино", voiceGender: "female" }, true);

describe("1. посторонний на линии — текст", () => {
  it("общий текст: цель не называется, одна фраза на любой вопрос, завершение wrong_person", () => {
    const rule = liveVoiceThirdPartyRule("кандидат");
    expect(rule).toContain("ЕСЛИ ТРУБКУ ВЗЯЛ НЕ КАНДИДАТ");
    expect(rule).toMatch(/даже если спросили прямо/);
    expect(rule).toContain("Я из Royal Home. Передайте, пожалуйста, что звонили из Royal Home и с ним свяжутся.");
    expect(rule).toContain("wrong_person");
    expect(rule).toMatch(/перезвонить не обещай/);
  });

  it("правило стоит во всех трёх сценариях: приглашение (ru и tg), опрос после показа, проверка собственника", () => {
    for (const [prompt, who] of [[invite("ru"), "КАНДИДАТ"], [invite("tg"), "КАНДИДАТ"], [post(), "ПОКУПАТЕЛЬ"], [probe(), "СОБСТВЕННИК"]] as const) {
      expect(prompt).toContain(`ЕСЛИ ТРУБКУ ВЗЯЛ НЕ ${who}`);
      expect(prompt).toContain("Цель звонка НЕ раскрывается");
    }
  });

  it("приглашение: заявку и работу называем только после подтверждения личности, а не в первой фразе", () => {
    const p = invite("ru");
    expect(p).toMatch(/говоришь ли ты с Мехрона/);
    expect(p).toMatch(/Про заявку, работу и собеседование НЕ говори, пока человек не подтвердил/);
    expect(p).not.toContain("Поздоровайся, назовись, скажи, что звонишь из Royal Home по его заявке на работу");
  });

  it("первая реплика (служебная) сначала уточняет, тот ли человек, и о цели не говорит", () => {
    for (const trigger of [INTERVIEW_INVITE_GREETING_TRIGGER, POST_SHOWING_CALL_GREETING_TRIGGER, SELLER_PROBE_CALL_GREETING_TRIGGER]) {
      expect(trigger).toContain("тот ли это человек");
      expect(trigger).toContain("О цели звонка пока не говори");
      expect(trigger).not.toMatch(/удобно ли говорить/);
    }
  });
});

describe("1. посторонний на линии — проверка кодом по итогу звонка", () => {
  const LEAK = ["Бот: Здравствуйте, Royal Home.", "Клиент: Алло, это мама Мехроны, её нет дома.", "Клиент: А зачем звоните?", "Бот: По поводу её заявки на работу и собеседования."];
  const CLEAN = ["Бот: Здравствуйте, это Royal Home.", "Клиент: Её нет дома.", "Клиент: Зачем звоните?", "Бот: Я из Royal Home. Передайте, пожалуйста, что звонили из Royal Home и с ней свяжутся."];

  it("находит слова цели в репликах робота и не ругается на чистый ответ", () => {
    expect(findThirdPartyDisclosure(LEAK)).toEqual(["заявка на работу", "собеседование"]);
    expect(findThirdPartyDisclosure(CLEAN)).toEqual([]);
    // слова клиента не считаются: говорил не робот
    expect(findThirdPartyDisclosure(["Клиент: я по поводу вакансии и собеседования", "Бот: Я из Royal Home."])).toEqual([]);
  });

  it("находит цену, адрес, объект и показ, в том числе по-таджикски", () => {
    expect(findThirdPartyDisclosure(["Бот: Показ квартиры на Бухоро, сорок девять, за 70 тысяч долларов."]).sort()).toEqual(["адрес", "деньги", "объект", "показ"]);
    expect(findThirdPartyDisclosure(["Бот: Барои мусоҳиба даъват мекунем."])).toEqual(["собеседование"]);
  });

  it("утечка → след в аудите и в журнале ошибок (только категории, не цитаты); чисто → ничего", () => {
    const audit: unknown[][] = [];
    const errors: string[] = [];
    const sink = { audit: (...a: unknown[]) => void audit.push(a), error: (m: string, k: string) => void errors.push(`${k}|${m}`) };
    expect(reportThirdPartyDisclosure("interview_invite", "call-1", LEAK, sink as never)).toEqual(["заявка на работу", "собеседование"]);
    expect(audit).toEqual([["robot_third_party_disclosure", "call-1", { terms: ["заявка на работу", "собеседование"] }]]);
    expect(errors[0]).toContain("robot-third-party-disclosure-interview_invite");
    expect(errors[0]).not.toContain("мама Мехроны");
    expect(errors[0]).not.toContain("по поводу её заявки");
    audit.length = 0;
    errors.length = 0;
    expect(reportThirdPartyDisclosure("post_showing", "call-2", CLEAN, sink as never)).toEqual([]);
    expect(audit).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("сбой следа не роняет разбор звонка", () => {
    const boom = { audit: () => { throw new Error("база"); }, error: () => undefined };
    expect(() => reportThirdPartyDisclosure("seller_probe", "x", LEAK, boom as never)).not.toThrow();
  });
});

describe("2. сроки перезвона — текст и сторож реплик", () => {
  it("правило в общем промте исходящего звонка клиенту и в сценарных (через общий сборщик)", () => {
    expect(buildLiveVoiceSystemPrompt({ clientName: "Зарина" })).toContain(LIVE_VOICE_NO_TIME_PROMISE_RULE.trim());
    expect(post()).toContain("<сроки_перезвона>");
    expect(probe()).toContain("<сроки_перезвона>");
    expect(invite("ru")).toContain("<сроки_перезвона>");
  });

  it("ловит «через полчаса», «в течение часа», «прямо сейчас перезвонит», а абсолютные сроки не трогает", () => {
    expect(findTimePromises("Агент наберёт вас в течение получаса.")).toEqual(["в течение получаса"]);
    expect(findTimePromises("Коллега перезвонит через пять минут.")).toEqual(["через пять минут"]);
    expect(findTimePromises("Мы свяжемся прямо сейчас.")).toEqual(["прямо сейчас"]);
    expect(findTimePromises("Агент позвонит через 10 минут")).toEqual(["через 10 минут"]);
    expect(findTimePromises("Агент свяжется сегодня после девяти.")).toEqual([]);
    expect(findTimePromises("Агент наберёт завтра в два часа дня.")).toEqual([]);
    // без слова о звонке — не срок перезвона (показ через час, дорога пять минут)
    expect(findTimePromises("До школы идти пять минут, через час откроется ярмарка.")).toEqual([]);
  });

  it("LiveVoiceReplyGuard: находка со сроком, поправка модели один раз, чистая реплика проходит", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru", knowledgeText: "", usdToTjs: 10.9 });
    const f = g.onModelText("Договорились, прямо сейчас передаю коллеге, чтобы набрал вас в течение получаса.");
    const found = f.find((x) => x.kind === "off_catalog");
    expect(found).toMatchObject({ kind: "off_catalog", timePromises: ["прямо сейчас", "в течение получаса"] });
    expect(found && found.kind === "off_catalog" && found.correction).toContain("ты не обещал(а)");
    expect(found && found.kind === "off_catalog" && found.summary).toContain("срок перезвона");
    g.onTurnComplete();
    expect(g.onModelText("Агент набёрт в течение получаса.").some((x) => x.kind === "off_catalog" && x.timePromises.includes("в течение получаса"))).toBe(false);
    g.onTurnComplete();
    expect(g.onModelText("Агент свяжется с вами сегодня после девяти.")).toEqual([]);
  });
});

describe("2. показ при выключенном тумблере — функций показа в наборе нет", () => {
  const names = (o: { transferAvailable: boolean; showingsEnabled: boolean }) => consultantToolsFor(o).map((t) => t.name);

  it("тумблер выключен: ни showing_slots, ни book_showing; остальное на месте", () => {
    const off = names({ transferAvailable: true, showingsEnabled: false });
    expect(off).not.toContain("showing_slots");
    expect(off).not.toContain("book_showing");
    for (const keep of ["save_client_request", "request_callback", "transfer_to_agent", "end_call", "search_properties"]) expect(off).toContain(keep);
  });

  it("тумблер включён: набор как был; перевод убирается независимо от показов", () => {
    expect(names({ transferAvailable: true, showingsEnabled: true })).toEqual(CONSULTANT_TOOLS.map((t) => t.name));
    const noTransfer = names({ transferAvailable: false, showingsEnabled: true });
    expect(noTransfer).not.toContain("transfer_to_agent");
    expect(noTransfer).toContain("book_showing");
    expect(names({ transferAvailable: false, showingsEnabled: false })).not.toContain("transfer_to_agent");
  });

  it("промт консультанта при выключенном тумблере тоже не зовёт показ (текст и набор согласованы)", () => {
    const base = { knowledge: "", caller: { numberKnown: true, selfName: null, agentName: null, dossier: "", weCalled: false }, withinWorkingHours: true, forceRussianOnly: true, language: "ru" as const, transferAvailable: false };
    expect(buildConsultantSystemPrompt({ ...base, showingsEnabled: false })).toMatch(/showing_slots и book_showing не зови/);
  });
});

describe("3. save_client_request — обязательные поля, «не хватает», один запрос на звонок", () => {
  const call = (args: Record<string, unknown>) => ({ id: "c1", name: "save_client_request", args });
  const memory = () => newPropertyCallMemory({ callerPhone: "992900000001", clientId: null });
  const FULL = { intent: "buy", district: "Сино", type: "APARTMENT", rooms: 2, budget_max: 70000, currency: "USD", timeframe: "до весны" };

  it("missingRequestFields: комнаты только у квартиры, валюта при названном бюджете, declined снимает поле", () => {
    expect(missingRequestFields({})).toEqual(["intent", "type", "district", "budget", "timeframe"]);
    expect(missingRequestFields({ intent: "buy", type: "APARTMENT", districtName: "Сино", budgetMax: 5 })).toEqual(["rooms", "currency", "timeframe"]);
    expect(missingRequestFields({ intent: "buy", type: "LAND", districtName: "Сино", budgetMax: 5, currency: "USD", timeframe: "x" })).toEqual([]);
    expect(missingRequestFields({ intent: "buy", type: "HOUSE" }, ["district", "budget", "timeframe"])).toEqual([]);
    expect(parseDeclinedFields("срок, timeframe; бюджет и мусор")).toEqual(["timeframe", "budget"]);
    expect(parseDeclinedFields(undefined)).toEqual([]);
  });

  it("неполный вызов: ошибка «не хватает: …», сказанное сохранено, робот не молчит (не SILENT)", async () => {
    const m = memory();
    const r = await handleClientTool(m, call({ intent: "buy", district: "Сино", rooms: 2, budget_max: 70000, currency: "USD" }));
    const body = r!.response as { ok: boolean; saved: boolean; missing: string[]; error: string };
    expect(body.ok).toBe(false);
    expect(body.saved).toBe(true);
    expect(body.missing).toEqual(["type", "timeframe"]);
    expect(body.error).toMatch(/^не хватает: тип .*; срок/);
    expect(body.error).toContain("declined");
    expect(r!.scheduling).not.toBe("SILENT");
    expect(m.request).toMatchObject({ intent: "buy", districtName: "Сино", rooms: 2, budgetMax: 70000, currency: "USD" });
  });

  it("повторный вызов дописывает те же условия, а не заводит второй набор; полный — ok и молча", async () => {
    const m = memory();
    await handleClientTool(m, call({ intent: "buy", district: "Сино" }));
    const first = m.request;
    const r = await handleClientTool(m, call(FULL));
    expect((r!.response as { ok: boolean }).ok).toBe(true);
    expect(r!.scheduling).toBe("SILENT");
    expect(m.request).toBe(m.request);
    expect(m.request).toMatchObject({ intent: "buy", districtName: "Сино", type: "APARTMENT", rooms: 2, budgetMax: 70000, currency: "USD", timeframe: "до весны" });
    expect(m.request).not.toBe(first);
    // тот же полный вызов ещё раз: ничего не меняется, ошибки нет
    const before = JSON.stringify(m.request);
    const again = await handleClientTool(m, call(FULL));
    expect((again!.response as { ok: boolean }).ok).toBe(true);
    expect(JSON.stringify(m.request)).toBe(before);
  });

  it("declined: человек не знает срока — вызов принимается, поле остаётся пустым", async () => {
    const m = memory();
    const r = await handleClientTool(m, call({ ...FULL, timeframe: undefined, declined: "timeframe" }));
    expect((r!.response as { ok: boolean }).ok).toBe(true);
    expect(m.request?.timeframe).toBeUndefined();
    expect(m.requestDeclined).toEqual(["timeframe"]);
  });

  it("пустой вызов по-прежнему «нечего записать»; описание функции говорит спросить недостающее до записи", async () => {
    const r = await handleClientTool(memory(), call({}));
    expect((r!.response as { error: string }).error).toContain("нечего записать");
    const decl = CLIENT_TOOLS.find((t) => t.name === "save_client_request")!;
    expect(decl.description).toMatch(/Сначала выясни по ходу разговора обязательное/);
    expect(decl.parameters.properties.declined).toBeDefined();
  });

  it("промт консультанта требует спросить недостающее до вызова", () => {
    const p = buildConsultantSystemPrompt({ knowledge: "", caller: { numberKnown: true, selfName: null, agentName: null, dossier: "", weCalled: false }, withinWorkingHours: true, forceRussianOnly: true, language: "ru", transferAvailable: false, showingsEnabled: true });
    expect(p).toMatch(/Не вызывай функцию с половиной данных/);
    expect(p).toContain("declined");
  });
});
