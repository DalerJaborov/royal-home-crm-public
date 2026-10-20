import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { learnedRulesBlock } from "../src/lib/botLessons.js";
import {
  AGENCY_FACTS,
  callbackPromise,
  callbackPromiseLine,
  chatHoursBlock,
  clientHoursSentence,
  companyInfoBlock,
  resolveClientHours,
} from "../src/ai/agencyFacts.js";
import { lessonConflict, lessonFitsSurface, type LessonConflictReason } from "../src/ai/agencyFactsLessons.js";
import { callbackAsLeadPromptRule, callbackPromptRule } from "../src/ai/callbackRequest.js";
import { findOffCatalogClaims } from "../src/ai/catalogClaimsGuard.js";
import { MANDATORY_BOT_RULES } from "../src/ai/dushanbeGeography.js";
import { INSPECTION_CHECKLIST_BLOCK } from "../src/ai/inspectionChecklist.js";
import { AGENCY_COMPANY_INFO, DEFAULT_BOT_PERSONA, buildStableSystem } from "../src/ai/leadQualifier.js";
import { LEGAL_FAQ_BLOCK } from "../src/ai/legalFaq.js";
import { buildConsultantSystemPrompt, type ConsultantCaller } from "../src/ai/liveVoiceConsultantPersona.js";
import { buildLiveVoiceKnowledge } from "../src/ai/liveVoiceKnowledge.js";
import { buildLiveVoiceSystemPrompt, LIVE_VOICE_MANDATORY_RULES } from "../src/ai/liveVoicePersona.js";
import { buildPostShowingCallPrompt } from "../src/ai/postShowingCallPersona.js";
import { SALES_FACTS } from "../src/ai/salesPlaybook.js";
import { buildSellerProbeCallPrompt } from "../src/ai/sellerProbeCallPersona.js";
import { callWhenPhrase } from "../src/lib/handoffPromise.js";
import { LiveVoiceReplyGuard, findOffCatalogClaims as voiceFindOffCatalogClaims } from "../src/lib/telephony/liveVoiceGuards.js";
import { SHOWINGS_DISABLED_RULE } from "../src/messengers/botCapabilities.js";

/**
 * ОДНО ОКНО ИНФОРМАЦИИ ДЛЯ ЧАТА И ГОЛОСА — СТОРОЖ (аудит 10.10.2026,
 * docs/audit-bots-2026-10-10-knowledge.md). Чистые функции, без базы и сети.
 *  1. Каждый блок фактов стоит в обоих промтах одним и тем же текстом.
 *  2. Обещание звонка агента одинаково в обоих каналах (одна функция).
 *  3. Тумблеры (показы) действуют одинаково.
 *  4. В учебных правилах нет противоречий фактам (27 синтетических примеров).
 *  5. Честность «ты бот?» не отменяет свой текст роли.
 *  6. Сторожа «вне подборки», запрещённых слов и повторов — общие.
 */

const HOURS = { start: "10:00", end: "22:30" };
const stranger: ConsultantCaller = { numberKnown: true, selfName: null, agentName: null, dossier: "" };
/** Душанбе = UTC+5. 05.10.2026 — понедельник, 10.10.2026 — суббота, 11.10.2026 — воскресенье. */
const dushanbe = (isoLocal: string) => new Date(new Date(`${isoLocal}:00Z`).getTime() - 5 * 3600_000);

function voiceKnowledge(): string {
  return buildLiveVoiceKnowledge({
    folkGeography: "\n<карта>Профсоюз — Сино</карта>",
    sellerRules: "",
    learnedRules: "",
    usdToTjs: 10.9,
    wallClock: new Date("2026-10-06T12:00:00Z"),
    workHours: HOURS,
  });
}

function voicePrompt(over: Partial<Parameters<typeof buildConsultantSystemPrompt>[0]> = {}): string {
  return buildConsultantSystemPrompt({
    knowledge: voiceKnowledge(),
    caller: stranger,
    withinWorkingHours: true,
    forceRussianOnly: true,
    callbackPromise: callbackPromise(dushanbe("2026-10-06T12:00"), HOURS),
    ...over,
  });
}

function chatStable(): string {
  return buildStableSystem({
    botPersona: DEFAULT_BOT_PERSONA,
    baseGeography: "",
    folkGeography: "",
    sellerRules: "",
    canSendGuide: true,
    canBookShowings: false,
    askOwner: false,
    scenarioId: null,
    intent: "buy",
    economy: false,
  });
}

describe("1. блоки фактов — один текст в обоих промтах", () => {
  it("company_info собирается из данных и стоит в чате, у консультанта и у исходящего робота", () => {
    expect(AGENCY_COMPANY_INFO).toBe(companyInfoBlock());
    expect(companyInfoBlock()).toContain("АРЕНДЫ СЕЙЧАС НЕТ");
    expect(companyInfoBlock()).toContain(AGENCY_FACTS.phone);
    const chat = chatStable();
    for (const block of [companyInfoBlock(), SALES_FACTS, LEGAL_FAQ_BLOCK, INSPECTION_CHECKLIST_BLOCK, MANDATORY_BOT_RULES]) {
      expect(chat, `чат: ${block.slice(0, 40)}`).toContain(block.trim());
      expect(voicePrompt(), `голос: ${block.slice(0, 40)}`).toContain(block.trim());
    }
    expect(buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: true })).toContain(companyInfoBlock().trim());
  });

  it("часы работы — одна фраза в чате и у голоса, из одного источника (CLIENT_HOURS)", () => {
    const sentence = clientHoursSentence(HOURS);
    expect(sentence).toContain("с 10:00 до 22:30");
    // Владелец 11.10.2026: выходных нет по умолчанию — «воскресенье — выходной» не звучит.
    expect(sentence).toContain("выходных нет — работаем каждый день");
    expect(sentence).not.toContain("воскресенье");
    expect(chatHoursBlock(HOURS)).toContain(sentence);
    expect(voiceKnowledge()).toContain(sentence);
    // Выходные — из Настроек: выбран общий выходной — бот его и называет.
    expect(clientHoursSentence({ ...HOURS, daysOff: [0] })).toContain("выходной — воскресенье");
    expect(clientHoursSentence({ ...HOURS, daysOff: [6, 0] })).toContain("выходные — суббота и воскресенье");
    // Источник по умолчанию — окно раздачи из Настроек, как у голоса до 10.10.
    expect(resolveClientHours({ workHoursStart: "10:00", workHoursEnd: "22:30" })).toEqual({ ...HOURS, daysOff: [] });
    expect(resolveClientHours({ workHoursStart: "10:00", workHoursEnd: "22:30", companyDaysOff: [0] })).toEqual({
      ...HOURS,
      daysOff: [0],
    });
    expect(resolveClientHours(null)).toBeNull();
    expect(chatHoursBlock(null)).toContain("Точных часов работы сейчас нет");
  });
});

describe("2. обещание звонка агента — одно решение на чат и голос", () => {
  /** Общий выходной в воскресенье — так было до 11.10.2026, теперь это выбор в Настройках. */
  const SUNDAY_OFF = { ...HOURS, daysOff: [0] };
  const cases: Array<[string, string, string, typeof HOURS & { daysOff?: number[] }]> = [
    ["по умолчанию воскресенье рабочее: воскресенье 15:00 — сегодня", "2026-10-11T15:00", "сегодня", HOURS],
    ["по умолчанию суббота 23:00 — завтра (воскресенье рабочее)", "2026-10-10T23:00", "завтра после 10:00", HOURS],
    ["общий выходной: воскресенье 15:00 — звонок завтра (понедельник)", "2026-10-11T15:00", "завтра после 10:00", SUNDAY_OFF],
    ["понедельник 11:00 — сегодня", "2026-10-05T11:00", "сегодня", HOURS],
    ["общий выходной: суббота 23:00 — понедельник, а не воскресенье", "2026-10-10T23:00", "в понедельник после 10:00", SUNDAY_OFF],
    ["будний 22:00 — до закрытия полчаса, уже завтра", "2026-10-06T22:00", "завтра после 10:00", HOURS],
    ["будний 07:30 — сегодня после начала окна", "2026-10-06T07:30", "сегодня после 10:00", HOURS],
  ];
  for (const [name, at, expected, hours] of cases) {
    it(name, () => {
      const p = callbackPromise(dushanbe(at), hours);
      expect(p.ru).toBe(expected);
      const line = callbackPromiseLine(p);
      // Чат (оба режима рубильника), передача заявки и голос говорят одно и то же.
      expect(callbackPromptRule(p)).toContain(line);
      expect(callbackAsLeadPromptRule(p)).toContain(line);
      if (!hours.daysOff) expect(callWhenPhrase(HOURS.start, HOURS.end, dushanbe(at)).ru).toBe(expected);
      const withinHours = p.kind === "today";
      expect(voicePrompt({ callbackPromise: p, withinWorkingHours: withinHours })).toContain(line);
      // «Прямо сейчас» не обещает никто и никогда.
      for (const text of [callbackPromptRule(p), callbackAsLeadPromptRule(p)]) expect(text).not.toContain("ПРЯМО СЕЙЧАС");
    });
  }

  it("в общий выходной «сегодня» не обещается ни в одном канале", () => {
    const p = callbackPromise(dushanbe("2026-10-11T12:00"), SUNDAY_OFF);
    expect(p.kind).not.toBe("today");
    expect(p.deferred).toBe(true);
  });

  it("личный выходной агента в среду: «сегодня» нет — звонок в четверг; у агента без выходных — сегодня", () => {
    // 07.10.2026 — среда.
    const wed = dushanbe("2026-10-07T12:00");
    const off = callbackPromise(wed, HOURS, [3]);
    expect(off.kind).toBe("tomorrow");
    expect(off.ru).toBe("завтра после 10:00");
    expect(callbackPromise(wed, HOURS, []).kind).toBe("today");
    // Вторник вечером: среда — его выходной, обещаем четверг.
    expect(callbackPromise(dushanbe("2026-10-06T23:00"), HOURS, [3]).ru).toBe("в четверг после 10:00");
  });
});

describe("3. тумблер показов — одинаково в чате и голосе", () => {
  it("показы выключены: голос времени не предлагает, как и чат", () => {
    const off = voicePrompt({ showingsEnabled: false });
    expect(off).not.toContain("showing_slots: назови одно-два свободных времени");
    expect(off).toContain("показ назначает агент");
    expect(SHOWINGS_DISABLED_RULE).toContain("ПОКАЗЫ ТЫ НЕ НАЗНАЧАЕШЬ");
  });

  it("показы включены: голос предлагает время через showing_slots", () => {
    expect(voicePrompt({ showingsEnabled: true })).toContain("showing_slots: назови одно-два свободных времени");
  });
});

describe("4. выученные правила не спорят с фактами компании", () => {
  /** 27 синтетических противоречий (по образцу находок аудита 10.10, без реальных текстов). */
  const CONFLICTS: Array<[string, LessonConflictReason]> = [
    ["Сообщайте клиенту о рассрочке от застройщиков на 12 месяцев.", "installments"],
    ["Если клиент спрашивает о способах оплаты, подтверди возможность рассрочки.", "installments"],
    ["Укажите на плюсы объекта: рассрочка, trade-in и хороший ремонт.", "installments"],
    ["Предлагай рассрочку, если бюджета не хватает.", "installments"],
    ["Скажи, что застройщик даёт рассрочку без процентов.", "installments"],
    ["Расскажи о помощи с ипотекой через банки-партнёры.", "mortgage"],
    ["Предложи оформить ипотеку, если денег не хватает.", "mortgage"],
    ["Подскажи, что банки-партнёры одобряют кредит быстро.", "mortgage"],
    ["Помогаем с ипотечным кредитом — так и говори.", "mortgage"],
    ["Клиенту без накоплений предложи кредит через банк.", "mortgage"],
    ["Если клиент ищет жильё на месяц, посоветуй Somon.tj.", "rent"],
    ["Предложи варианты аренды в Сино.", "rent"],
    ["Посоветуй Telegram-каналы с арендой квартир.", "rent"],
    ["Помоги собственнику сдать квартиру в аренду.", "rent"],
    ["Скажи, что через нас можно снять квартиру на месяц.", "rent"],
    ["Гарантируйте клиенту проверку документов и отсутствие «красных линий».", "guarantee"],
    ["Скажи, что мы гарантируем юридическую чистоту сделки.", "guarantee"],
    ["Даём гарантию, что квартира без долгов, — так и отвечай.", "guarantee"],
    ["Предложите встречу с собственником на объекте для торга.", "owner_bargaining"],
    ["Чтобы снизить цену, сведи клиента с хозяином квартиры напрямую.", "owner_bargaining"],
    ["Скажи, что скидка может быть до 5%.", "discount_size"],
    ["Обещай 3% скидки при быстрой сделке.", "discount_size"],
    ["Комиссия агентства для покупателя — 1%.", "commission"],
    ["Говори, что комиссия продавца 3 процента.", "commission"],
    ["Принимаем объекты и в Худжанде — бери номер.", "other_city"],
    ["Указывай срок готовности ролика 1–2 дня.", "unbacked_promise"],
    ["} his", "garbage"],
  ];

  it("ровно 27 примеров, и каждый пойман со своей причиной", () => {
    expect(CONFLICTS).toHaveLength(27);
    for (const [text, reason] of CONFLICTS) expect(lessonConflict(text), text).toBe(reason);
  });

  it("правила, повторяющие факт (с отрицанием), и обычные советы проходят", () => {
    const OK = [
      "Рассрочки нет — так и говори, не обещай её.",
      "Не обещай ипотеку: её у нас нет.",
      "Аренды у нас нет — скажи честно одной фразой.",
      "Не гарантируй, что всё чисто: проверку делает нотариус.",
      "Комиссия 2% платит продавец, с покупателя не берём.",
      "Отвечай коротко и по делу, без длинных абзацев.",
      "Если клиент назвал район, сразу предложи два-три варианта из подборки.",
      "Торг есть всегда, размер обсуждает агент с собственником после просмотра.",
    ];
    for (const text of OK) expect(lessonConflict(text), text).toBeNull();
  });

  it("отрицание из соседнего предложения не засчитывается", () => {
    expect(lessonConflict("У клиента нет денег сразу. Предложи рассрочку.")).toBe("installments");
  });

  it("канал: голосу — звонки и общие, публичным комментариям — без сценариев звонка", () => {
    expect(lessonFitsSurface("PHONE", "voice")).toBe(true);
    expect(lessonFitsSurface("ALL", "voice")).toBe(true);
    expect(lessonFitsSurface("WHATSAPP", "voice")).toBe(false);
    expect(lessonFitsSurface("PHONE", "comments")).toBe(false);
    expect(lessonFitsSurface("INSTAGRAM", "comments")).toBe(true);
    expect(lessonFitsSurface("PHONE", "chat")).toBe(true);
  });
});

describe("5. честность на прямой вопрос — свой текст роли её не отменяет", () => {
  /** Старая копия роли 12–13.09 (как сохранена на проде): «ЗВУЧИ КАК ЖИВОЙ…» + запрет признаваться. */
  const OLD_ROLE =
    "<system_role>\nТы — консультант агентства недвижимости Royal Home.\n\nЗВУЧИ КАК ЖИВОЙ ЧЕЛОВЕК, А НЕ КАК ДИКТОР.\n\n" +
    "НИКОГДА не говори, что ты ИИ, бот, программа или голосовой ассистент — даже если спросят прямо. Ты консультант агентства.\n</system_role>";

  it("правило честности приклеено после роли из Настроек, даже с «ЗВУЧИ КАК ЖИВОЙ ЧЕЛОВЕК»", () => {
    for (const forceRussianOnly of [true, false]) {
      const prompt = buildLiveVoiceSystemPrompt(undefined, { roleOverride: OLD_ROLE, forceRussianOnly });
      expect(prompt).toContain(LIVE_VOICE_MANDATORY_RULES.trim());
      expect(prompt.indexOf(LIVE_VOICE_MANDATORY_RULES.trim())).toBeGreaterThan(prompt.indexOf("даже если спросят прямо"));
    }
  });

  it("сценарные звонки (свой текст роли) тоже несут правило честности", () => {
    const prompts = [
      buildPostShowingCallPrompt({ clientName: "Анна", propertyTitle: "Двушка", agentName: "Далер", whenLabel: "вчера" }, true),
      buildSellerProbeCallPrompt({ sellerName: "Анвар", propertyLabel: "двушка" }, true),
    ];
    for (const p of prompts) expect(p).toContain(LIVE_VOICE_MANDATORY_RULES.trim());
  });

  it("зашитая роль несёт честность сама — второй блок не печатается", () => {
    const stock = buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: true });
    expect(stock).toContain("голосовой помощник агентства Royal Home, не человек");
    expect(stock).not.toContain("<обязательные_правила>");
  });
});

describe("6. сторожа — общие для чата и голоса", () => {
  it("«вне подборки» — одна функция: голос переизлучает ту же, чат зовёт её же", () => {
    expect(voiceFindOffCatalogClaims).toBe(findOffCatalogClaims);
    const claims = findOffCatalogClaims({ text: "Есть двушка, 87 м², 15 этаж.", allowedText: "", catalogText: "", clientText: "" });
    expect(claims.areas).toEqual([87]);
    expect(claims.floors).toEqual([15]);
    const ok = findOffCatalogClaims({
      text: "Есть двушка, 87 м², 15 этаж.",
      allowedText: "",
      catalogText: "№12: 2-комн., 87 м², 15 этаж",
      clientText: "",
    });
    expect(ok.areas).toEqual([]);
    expect(ok.floors).toEqual([]);
  });

  it("голос ловит запрещённые таджикские слова тем же списком, что чат", () => {
    const guard = new LiveVoiceReplyGuard({ language: "tg" });
    const findings = guard.onModelText("Рақаматонро, лутфан, гӯед, агенти мо занг мезанад.");
    const f = findings.find((x) => x.kind === "off_catalog");
    expect(f && f.kind === "off_catalog" ? f.bannedWords : []).toEqual(["лутфан"]);
  });

  it("голос ловит дословный повтор прошлой реплики", () => {
    const guard = new LiveVoiceReplyGuard({ language: "ru" });
    const phrase = "Хорошо, агент вам наберёт и всё подробно расскажет.";
    expect(guard.onModelText(phrase)).toEqual([]);
    guard.onTurnComplete();
    const findings = guard.onModelText(phrase);
    const f = findings.find((x) => x.kind === "off_catalog");
    expect(f && f.kind === "off_catalog" ? f.repeated : false).toBe(true);
  });
});

describe("4б. отбор в промт: противоречащее фактам и чужой канал не подмешиваются (база не меняется)", () => {
  const runId = `${Date.now()}`;
  const ids: string[] = [];
  const texts = {
    conflict: `Подтверди клиенту рассрочку от застройщика ${runId}.`,
    whatsapp: `Пиши клиенту коротко и кириллицей ${runId}.`,
    phone: `Спроси, на какой этаж клиент рассчитывает ${runId}.`,
  };

  beforeAll(async () => {
    for (const [channel, lesson] of [
      ["PHONE", texts.conflict],
      ["WHATSAPP", texts.whatsapp],
      ["PHONE", texts.phone],
    ] as const) {
      const row = await prisma.botLesson.create({
        data: { kind: "call_answer", channel, botMessage: `вопрос ${runId} ${channel} ${lesson.length}`, humanMessage: "ответ", lesson, active: true },
      });
      ids.push(row.id);
    }
  });

  afterAll(async () => {
    await prisma.botLesson.deleteMany({ where: { id: { in: ids } } });
  });

  it("правило про рассрочку остаётся в базе активным, но ни в чат, ни в голос не идёт", async () => {
    const chat = await learnedRulesBlock("chat");
    const voice = await learnedRulesBlock("voice");
    expect(chat).not.toContain(texts.conflict);
    expect(voice).not.toContain(texts.conflict);
    expect((await prisma.botLesson.findUnique({ where: { id: ids[0] } }))?.active).toBe(true);
  });

  it("правило переписки — в чат, не в голос; правило звонка — в оба", async () => {
    const chat = await learnedRulesBlock("chat");
    const voice = await learnedRulesBlock("voice");
    const comments = await learnedRulesBlock("comments");
    expect(chat).toContain(texts.whatsapp);
    expect(voice).not.toContain(texts.whatsapp);
    expect(chat).toContain(texts.phone);
    expect(voice).toContain(texts.phone);
    expect(comments).not.toContain(texts.phone);
  });
});
