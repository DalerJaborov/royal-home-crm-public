import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { classifyLeadOnlyIntent, leadOnlyIntentFallback, leadOnlyIntentFromModel, leadOnlyIntentOnce, LEAD_ONLY_INTENT_SYSTEM,
  type LeadOnlyIntentModel } from "../src/ai/leadOnlyIntent.js";
import { leadOnlyScenario, LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { planLegacyLeadOnlyTurn } from "../src/messengers/leadOnlyLegacy.js";

/**
 * РОЛЬ И ГОРЯЧЕСТЬ КЛИЕНТА В РЕЖИМЕ «ТОЛЬКО ЗАЯВКИ» РЕШАЕТ МОДЕЛЬ (аудит 14.11.2026, класс «регулярка решает вместо ИИ»).
 * Модель подменена (живых вызовов нет): тест про то, что код делает с её ответом — берёт роль только из перечня и с
 * цитатой из слов клиента, держит запреты владельца (аренда, вакансии) поверх модели и уходит на запасные регулярки,
 * когда модель не ответила или ответила неправдоподобно.
 *
 * ТАБЛИЦА: новую живую фразу, на которой бот ошибся, дописывать сюда строкой.
 * [текст, прежние слова клиента, ответ модели, сценарий с моделью, сценарий без модели (null в колонке — «не ход заявки»;
 *  undefined — запасной путь контекста не видит и здесь не проверяется)]
 */
type Answer = { role: string; quote: string; hot: boolean; hotQuote: string };
type Row = [lang: "ru" | "tg", text: string, earlier: string[], answer: Answer, withModel: string | null, withoutModel?: string | null];
const ans = (role: string, quote = "", hot = false, hotQuote = ""): Answer => ({ role, quote, hot, hotQuote });

const PHRASES: Row[] = [
  // ── три фразы аудита 14.11 ──
  ["ru", "Подскажите, сколько стоит", ["Хочу продать свою квартиру"], ans("seller", "Хочу продать свою квартиру"), "seller", undefined],
  ["ru", "Адрес офиса?", [], ans("other"), null, null],
  ["tg", "Хона мехоҳам, пул дорам", [], ans("buyer", "Хона мехоҳам"), "buyer", "buyer"],
  // ── покупатель ──
  ["tg", "Пул дорам", [], ans("buyer", "пул дорам"), "buyer", "buyer"],
  ["tg", "Хона мехохам", [], ans("buyer", "Хона мехохам"), "buyer", "buyer"],
  ["ru", "Ищу двухкомнатную квартиру в Сино", [], ans("buyer", "Ищу двухкомнатную квартиру"), "buyer", "buyer"],
  ["ru", "Подскажите, есть 2-комнатные в Сино?", [], ans("buyer", "есть 2-комнатные в Сино"), "buyer", "buyer"],
  ["tg", "Ду хонагӣ дар Сино ҳаст?", [], ans("buyer", "Ду хонагӣ дар Сино"), "buyer"],
  // ── продавец ──
  ["tg", "Фурӯхтан мехоҳам", [], ans("seller", "Фурӯхтан мехоҳам"), "seller", "seller"],
  ["tg", "Хонаамро фурӯхтан мехоҳам", [], ans("seller", "Хонаамро фурӯхтан мехоҳам"), "seller", "seller"],
  ["ru", "Продаю квартиру, адрес Сино 12", [], ans("seller", "Продаю квартиру"), "seller", "seller"],
  ["ru", "Сколько вы берёте?", ["Продаю дом в Гипроземе"], ans("seller", "Продаю дом"), "seller"],
  // ── аренда и работа: не ход заявки (запрет владельца решает код) ──
  ["tg", "Иҷора", [], ans("renter", "Иҷора"), null, null],
  ["tg", "Хона ба иҷора лозим", [], ans("renter", "иҷора лозим"), null, null],
  ["ru", "Сдаю квартиру", [], ans("landlord", "Сдаю квартиру"), null, null],
  ["ru", "Сдам дом", [], ans("landlord", "Сдам дом"), null, null],
  ["tg", "Ҷои кор доред?", [], ans("job", "Ҷои кор"), null, null],
  // ── горячее ──
  ["ru", "Хотим посмотреть, куда ехать?", [], ans("buyer", "Хотим посмотреть", true, "куда ехать"), "hot", "hot"],
  ["ru", "Какой адрес? Завтра приедем", [], ans("buyer", "Завтра приедем", true, "Завтра приедем"), "hot", "hot"],
  ["tg", "Кай омада метавонем?", [], ans("buyer", "Кай омада метавонем", true, "Кай омада метавонем"), "hot", "hot"],
  ["tg", "Куҷо биёем?", [], ans("other", "", true, "Куҷо биёем"), "hot", "hot"],
  // ── не горячее ──
  ["ru", "Какой адрес?", [], ans("other"), null, null],
  ["ru", "Можно посмотреть фото?", [], ans("buyer", "посмотреть фото"), "buyer"],
  ["ru", "Хотим посмотреть, но не сейчас", [], ans("buyer", "Хотим посмотреть"), "buyer"],
  ["ru", "Здравствуйте", [], ans("other"), null, null],
  ["tg", "Ташаккур", [], ans("other"), null, null],
];

const config = { hotIntentHandover: true };
const answering = (answer: unknown): LeadOnlyIntentModel => async () => answer;
const silent: LeadOnlyIntentModel = async () => null;

async function scenarioOf(text: string, earlier: string[], model: LeadOnlyIntentModel) {
  const intent = await classifyLeadOnlyIntent({ current: text, earlier }, model);
  return { intent, scenario: leadOnlyScenario({ text, propertyKnown: false, config, intent }) };
}

describe("таблица фраз: роль и горячесть по модели", () => {
  it("в таблице оба языка, есть и продавец, и покупатель, и аренда, и горячее", () => {
    for (const lang of ["ru", "tg"] as const) expect(PHRASES.some(([l]) => l === lang)).toBe(true);
    for (const scenario of ["seller", "buyer", "hot", null]) expect(PHRASES.some(row => row[4] === scenario), String(scenario)).toBe(true);
    expect(PHRASES.length).toBeGreaterThanOrEqual(25);
  });
  it.each(PHRASES)("с моделью (%s): «%s»", async (_lang, text, earlier, answer, withModel) => {
    const { intent, scenario } = await scenarioOf(text, earlier, answering(answer));
    expect(intent.source).toBe("model");
    expect(scenario).toBe(withModel);
  });
  it.each(PHRASES.filter(row => row[5] !== undefined))("без ответа модели — запасной путь (%s): «%s»", async (_lang, text, earlier, _answer, _withModel, withoutModel) => {
    const { intent, scenario } = await scenarioOf(text, earlier, silent);
    expect(intent.source).toBe("fallback");
    expect(scenario).toBe(withoutModel);
  });
});

describe("аудит 14.11: три фразы, на которых регулярка ошибалась", () => {
  it("«подскажите, сколько стоит» у продавца — продавец; одно «подскажите» роли не даёт", async () => {
    expect((await scenarioOf("Подскажите, сколько стоит", ["Хочу продать свою квартиру"], answering(ans("seller", "Хочу продать свою квартиру")))).scenario).toBe("seller");
    expect(LEAD_ONLY_INTENT_SYSTEM).toMatch(/подскажите.*само по себе роли не даёт/iu);
  });
  it("«адрес офиса?» — не горячее, даже если модель ошиблась ролью: офис в горячие не попадает ни там, ни там", async () => {
    expect((await scenarioOf("Адрес офиса?", [], answering(ans("other")))).scenario).not.toBe("hot");
    expect((await scenarioOf("Адрес офиса?", [], silent)).scenario).not.toBe("hot");
  });
  it("«Хона мехоҳам, пул дорам» — покупатель и с моделью, и запасным путём (раньше: продавец)", async () => {
    expect((await scenarioOf("Хона мехоҳам, пул дорам", [], answering(ans("buyer", "Хона мехоҳам")))).scenario).toBe("buyer");
    expect(leadOnlyIntentFallback("Хона мехоҳам, пул дорам").role).toBe("buyer");
  });
});

describe("код проверяет ответ модели", () => {
  it("роль вне перечня, не тот тип или пустой ответ — запасной путь", async () => {
    for (const bad of [{ role: "investor", quote: "Хочу купить", hot: false, hotQuote: "" }, { role: "buyer", quote: "Хочу купить", hot: "yes" }, "buyer", 42, {}]) {
      const intent = await classifyLeadOnlyIntent({ current: "Хочу купить квартиру" }, answering(bad));
      expect(intent.source, JSON.stringify(bad)).toBe("fallback");
      expect(intent.fallbackReason).toBe("invalid_answer");
      expect(intent.role).toBe("buyer");
    }
  });
  it("выдуманная цитата — не принимается: роль только по словам клиента", async () => {
    const intent = await classifyLeadOnlyIntent({ current: "Здравствуйте" }, answering(ans("seller", "хочу продать квартиру")));
    expect(intent).toMatchObject({ source: "fallback", fallbackReason: "quote_not_found", role: "other" });
  });
  it("горячесть — только по словам ЭТОГО сообщения: вчерашнее «хочу посмотреть» не греет сегодняшнее «спасибо»", async () => {
    const intent = await classifyLeadOnlyIntent({ current: "Спасибо", earlier: ["Хочу посмотреть квартиру"] },
      answering(ans("buyer", "Хочу посмотреть квартиру", true, "Хочу посмотреть квартиру")));
    expect(intent).toMatchObject({ source: "fallback", fallbackReason: "quote_not_found", hot: false });
  });
  it("цитата узнаётся без таджикских букв, без ё и знаков: «Хона мехохам» в «Хона мехоҳам!»", () => {
    expect(leadOnlyIntentFromModel(ans("buyer", "хона мехохам"), { current: "Хона мехоҳам!", earlier: [] })).toMatchObject({ role: "buyer", source: "model" });
  });
  it("короткая цитата — только целым словом: «да» не находится в «задаток»", () => {
    expect(leadOnlyIntentFromModel(ans("buyer", "да"), { current: "Какой задаток?", earlier: [] })).toEqual({ invalid: "quote_not_found" });
  });
  it("запреты владельца сильнее модели: аренда и вакансия — не ход заявки, даже если модель сказала «покупатель»", async () => {
    expect((await scenarioOf("Хона ба иҷора лозим", [], answering(ans("buyer", "Хона ба иҷора лозим")))).scenario).toBeNull();
    expect((await scenarioOf("Есть вакансия? Ищу работу", [], answering(ans("buyer", "Ищу работу")))).scenario).toBeNull();
  });
  it("горячие слова выключены рубильником — горячесть модели ничего не меняет", async () => {
    const intent = await classifyLeadOnlyIntent({ current: "Хотим посмотреть" }, answering(ans("buyer", "Хотим посмотреть", true, "Хотим посмотреть")));
    expect(leadOnlyScenario({ text: "Хотим посмотреть", propertyKnown: false, config: { hotIntentHandover: false }, intent })).toBe("buyer");
  });
});

describe("нет ответа модели — запасная регулярка, клиент без ответа не остаётся", () => {
  it("модель бросила ошибку", async () => {
    const intent = await classifyLeadOnlyIntent({ current: "Хочу продать квартиру" }, async () => { throw new Error("503"); });
    expect(intent).toMatchObject({ source: "fallback", fallbackReason: "model_unavailable", role: "seller" });
  });
  it("модель молчит дольше срока — не ждём", async () => {
    const started = Date.now();
    const intent = await classifyLeadOnlyIntent({ current: "Хочу посмотреть" }, () => new Promise(() => {}), 30);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(intent).toMatchObject({ source: "fallback", fallbackReason: "model_unavailable", hot: true });
  });
  it("в сообщении нет слов (номер, эмодзи) — модель не зовётся вовсе", async () => {
    const model = vi.fn(answering(ans("buyer", "x")));
    for (const text of ["93 555 12 34", "👍", ""]) expect((await classifyLeadOnlyIntent({ current: text }, model)).fallbackReason).toBe("no_letters");
    expect(model).not.toHaveBeenCalled();
  });
  it("слова клиента идут модели данными (JSON), без врезок из файлов, не больше шести прежних сообщений", async () => {
    const model = vi.fn(answering(ans("other")));
    const earlier = Array.from({ length: 9 }, (_, i) => `сообщение ${i}`);
    await classifyLeadOnlyIntent({ current: "Здравствуйте", earlier }, model);
    const user = JSON.parse(model.mock.calls[0][0].user);
    expect(user.currentClientMessage).toBe("Здравствуйте");
    expect(user.earlierClientMessages).toEqual(earlier.slice(-6));
  });
  it("один разбор на ход: одно и то же сообщение модель видит один раз", async () => {
    const calls = vi.fn(async (text: string) => leadOnlyIntentFallback(text));
    const once = leadOnlyIntentOnce(calls);
    await once("Хочу купить", []); await once("Хочу купить", []); await once("Хочу продать", []);
    expect(calls).toHaveBeenCalledTimes(2);
  });
});

describe("старый путь берёт роль из той же двери", () => {
  const base = { config: { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" }, channel: "INSTAGRAM",
    subscriberId: "intent-test-peer", linked: false, draft: { stage: "chatting" as const }, propertyId: null, propertyInMessage: false, language: "ru" as const };
  const door = (model: LeadOnlyIntentModel) => (text: string, earlier: readonly string[]) => classifyLeadOnlyIntent({ current: text, earlier }, model);
  const history = [{ role: "user" as const, content: "Хочу продать свою квартиру" }, { role: "assistant" as const, content: "Понял вас." }];
  it("«подскажите, сколько стоит» после «хочу продать» — ответ продавцу, а не подборка покупателю", async () => {
    const model = vi.fn(answering(ans("seller", "Хочу продать свою квартиру")));
    const plan = await planLegacyLeadOnlyTurn({ ...base, text: "Подскажите, сколько стоит", history, classifyIntent: door(model) });
    expect(plan?.scenario).toBe("seller");
    expect(plan?.reply).toMatch(/поможем продать/u);
    expect(JSON.parse(model.mock.calls[0][0].user).earlierClientMessages).toEqual(["Хочу продать свою квартиру"]);
  });
  it("модель не ответила — прежнее решение регулярок", async () => {
    const plan = await planLegacyLeadOnlyTurn({ ...base, text: "Хочу продать дом", history: [], classifyIntent: door(silent) });
    expect(plan?.scenario).toBe("seller");
  });
});

describe("сторож одной двери", () => {
  it("роль и горячесть для режима не решаются в обход ai/leadOnlyIntent.ts", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "generated") walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = path.relative(root, full).replaceAll("\\", "/");
        if (rel === "ai/leadOnlyIntent.ts" || rel === "ai/leadOnlyMode.ts") continue;
        if (/\bleadOnlyHotIntent\s*\(/u.test(readFileSync(full, "utf8"))) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
