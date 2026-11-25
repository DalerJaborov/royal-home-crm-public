import { describe, expect, it } from "vitest";
import { decide, initialOperatorState } from "../src/ai/operator/decide.js";
import { OPERATOR_PHRASES, renderOperatorReply, renderOperatorStep } from "../src/ai/operator/phrases.js";
import { understandFallback } from "../src/ai/operator/understand.js";
import { withoutOwnRepeats } from "../src/ai/operator/index.js";
import { readOperatorState, serializeOperatorState } from "../src/ai/operator/state.js";
import { leadOnlyOutgoing } from "../src/ai/leadOnlyMode.js";
import { stripCallTimePromise } from "../src/ai/callTimePromiseGuard.js";
import { customerPublicLanguage, customerPublicSellerOffer } from "../src/ai/customerAgentConversationPolicy.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerAgentVerifiedContextSchema } from "@royal-home/shared";
import type { OperatorContext, OperatorState, PhraseKey } from "../src/ai/operator/types.js";

/**
 * Живые ошибки нового ядра бота на проде 23–24.11.2026 (D:\CRM\.tmp-bot-live-watch\findings.md, пункты 1–13). Каждый тест —
 * реальный диалог (id в названии), прогон через то же понимание кодом (understandFallback) и то же решение (decide), что и прод.
 */
const ctx = (over: Partial<OperatorContext> = {}): OperatorContext => ({
  channel: "WHATSAPP", phoneKnown: true, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "сегодня после 10:00", tg: "имрӯз баъд аз соати 10:00" }, recruiterPath: true, ad: { topic: "seller", propertyId: null },
  focus: null, callbackWhen: { ru: "завтра с 10:00", tg: "пагоҳ аз соати 10:00" }, maxPhoneAsks: 2, vacancies: { open: [], contactPhone: null },
  brandName: "Royal Home", officePhone: "+992 00 000 00 02", sellerCommissionPercent: 2, outOfArea: false, ...over,
});
const IG = (over: Partial<OperatorContext> = {}) => ctx({ channel: "INSTAGRAM", phoneKnown: false, ...over });

function dialog(c: OperatorContext, texts: string[], start: OperatorState = initialOperatorState()) {
  let state = start, accepted = false;
  return texts.map(text => {
    const turnCtx = accepted && !c.leadExists ? { ...c, leadPending: true } : c;
    const u = understandFallback({ current: text }, state, turnCtx);
    const d = decide(state, u, turnCtx);
    state = d.state;
    if (d.actions.some(a => a.type === "accept_lead")) accepted = true;
    return { u, d, keys: d.steps.map(s => s.key), text: leadOnlyOutgoing(renderOperatorReply(d.steps, d.language) || "", d.language) };
  });
}
const leadsOf = (turns: ReturnType<typeof dialog>) => turns.flatMap(t => t.d.actions.filter(a => a.type === "accept_lead"));
const CLOCK_OR_DAY = /\d{1,2}[:.]\d{2}|сегодня|завтра|имрӯз|пагоҳ|соати|ба зудӣ|в ближайшее время/iu;

describe("п.1 срок звонка агента не называется никогда (7d0df9a4 09:37, bd6aeec4, 7b231fa1, fa92b195)", () => {
  it("ни одна фраза оператора не несёт срока звонка — ни переменной {when}/{time}, ни дня; последняя дверь не меняет ни одной фразы", () => {
    // Все переменные фраз — образцами данных (часы работы — настоящими часами: ревью #418, сторож вырезал их из «Мы на связи с…»).
    const vars = { id: 214, price: "75 000 USD", place: "Сино, Душанбе", percent: 2, phone: "+992 00 000 00 02", brand: "Royal Home",
      from: "09:30", to: "18:00", missing: ["district", "price"], where: "WHATSAPP", list: ["менеджер"], position: "менеджер", time: "с 11:00 до 14:30",
      wish: "завтра в 13:00", facts: "комнат: 3, площадь: 95 м²" };
    // ЯВНОЕ ИСКЛЮЧЕНИЕ (25.11.2026, ревью #425): {wish} — повтор слов клиента, не наш срок. Такая фраза несёт время только
    // переменной (разобранной кодом из слов клиента), в кавычках и без глагола связи — сторож срока её не трогает.
    const CLIENT_WISH_KEYS = new Set(["callback_time_noted", "lead_callback_time"]);
    for (const [key, phrase] of Object.entries(OPERATOR_PHRASES)) {
      for (const [language, variants] of [["ru", phrase.ru], ["tg", phrase.tg]] as const) {
        variants.forEach((template, variant) => {
          expect(template, key).not.toMatch(/\{when\}|\{time\}/u);
          if (CLIENT_WISH_KEYS.has(key)) {
            expect(template, key).toContain("«{wish}»");
            expect(template, key).not.toMatch(/позвон|свяж|занг|тамос/iu);
          } else expect(template, key).not.toContain("{wish}");
          expect(template, key).not.toMatch(/сегодня|завтра|имрӯз|пагоҳ|ба зудӣ|в ближайшее время/iu);
          const text = renderOperatorStep({ key: key as PhraseKey, vars, variant }, language);
          expect(leadOnlyOutgoing(text, language), `${key}/${language}/${variant}`).toBe(text);
        });
      }
    }
  });
  it("ревью #418: «когда работаете» — часы работы доходят до клиента через последнюю дверь целиком", () => {
    for (const language of ["ru", "tg"] as const) {
      for (const variant of [0, 1]) {
        const text = renderOperatorStep({ key: "work_hours", vars: { from: "09:30", to: "18:00" }, variant }, language);
        const out = leadOnlyOutgoing(text, language);
        expect(out).toContain("09:30");
        expect(out).toContain("18:00");
      }
    }
  });
  it("последняя дверь режима режет срок, даже если он пришёл (прежняя фраза no_agent_noted с 09:37)", () => {
    expect(leadOnlyOutgoing("Навиштем, имрӯз баъд аз соати 10:00 бо шумо тамос мегиранд.", "tg")).toBe("Навиштем, бо шумо тамос мегиранд.");
    expect(leadOnlyOutgoing("Спасибо, передаю агенту, он позвонит вам завтра с 10:00, а пока можете рассказать о квартире.", "ru"))
      .not.toMatch(CLOCK_OR_DAY);
    expect(stripCallTimePromise("Ташаккур, ба агент мерасонам, ӯ пагоҳ аз соати 10:00 занг мезанад.")).not.toMatch(CLOCK_OR_DAY);
  });
  it("после заявки карточка без агента (7d0df9a4): «Навиштем, бо шумо тамос мегиранд.» — без срока", () => {
    const c = IG({ leadExists: true, cardAgentActive: false });
    const lead = { ...initialOperatorState(), role: "buyer" as const, leadAccepted: true, step: "done" as const, language: "tg" as const };
    const [t] = dialog(c, ["Аз доми кухнабошадам мерад бе ремонт"], lead);
    expect(t!.text).not.toMatch(CLOCK_OR_DAY);
    expect(t!.keys).toEqual(["no_agent_noted"]);
  });
});

describe("п.2–3 заявка только после роли и сути; в WhatsApp — «позвонит на этот номер WhatsApp»", () => {
  it("8598aef1: «Салом» в WhatsApp с рекламы собственникам — приветствие и вопрос о роли, заявки нет", () => {
    const [t] = dialog(ctx(), ["Салом"]);
    expect(leadsOf([t!])).toEqual([]);
    expect(t!.keys).toEqual(["greet", "ask_role"]);
  });
  it("1a1a93c4: «Мефрушем» — комиссия и вопрос «что и где», заявки нет; ответ — заявка на номер WhatsApp", () => {
    const [ask, role, answer] = dialog(ctx(), ["Хизмати шумо чанд пул мешавад?", "Мефрушем", "Сино, 2 хонага, 60 ҳазор доллар"]);
    expect(leadsOf([ask!, role!])).toEqual([]);
    expect(role!.keys).toEqual(["seller_intro", "role_details_seller"]);
    expect(role!.text).not.toMatch(/агент мерасонам|занг мезанад/u);
    expect(leadsOf([answer!])).toMatchObject([{ role: "seller" }]);
    expect(answer!.text).toMatch(/рақами WhatsApp/u);
    expect(answer!.text).not.toMatch(CLOCK_OR_DAY);
  });
  it("2c87db12: «мехарем» — один вопрос по сути, без заявки", () => {
    const [, t] = dialog(ctx(), ["салом", "мехарем"]);
    expect(t!.keys).toEqual(["role_details_buyer"]);
    expect(leadsOf([t!])).toEqual([]);
  });
  it("номер в словах — заявка сразу, как и прежде (владелец 20.11)", () => {
    const [t] = dialog(ctx(), ["Мефурушам, 900123456"]);
    expect(leadsOf([t!])).toHaveLength(1);
  });
  it("«Вы бот? Позовите человека» без роли — не заявка «цель не названа», а вопрос о роли", () => {
    const [t] = dialog(ctx(), ["Вы бот? Дайте живого человека"]);
    expect(leadsOf([t!])).toEqual([]);
    expect(t!.keys).toContain("ask_role");
  });
  it("п.12, f0de425b: шаблон рекламы «Можно узнать об этом подробнее?» — вопрос о роли, не заявка покупателя", () => {
    const [t] = dialog(ctx({ ad: { topic: "property", propertyId: null } }), ["Привет! Можно узнать об этом подробнее?"]);
    expect(leadsOf([t!])).toEqual([]);
    expect(t!.keys).toContain("ask_role");
  });
  it("п.12: одинокий «?» после заявки — напоминание, а не тишина; до заявки — вопрос о роли", () => {
    const lead = { ...initialOperatorState(), role: "buyer" as const, leadAccepted: true, step: "done" as const, language: "ru" as const };
    const [after] = dialog(ctx({ leadExists: true }), ["?"], lead);
    expect(after!.keys).toEqual(["lead_reminder"]);
    const [before] = dialog(IG(), ["?"]);
    expect(before!.keys).toEqual(["ask_role"]);
  });
});

describe("п.4–5 простые вопросы — ответ сам, а не «скажет агент» и не «передал ваш вопрос»", () => {
  const afterLead = (role: "buyer" | "seller"): OperatorState =>
    ({ ...initialOperatorState(), role, leadAccepted: true, step: "done", language: "tg", asked: { role: 1, details: 1, phone: 0 } });
  it("b0c0290a: «Ин роял ҳом шартҳояш чихел хизматрасонии чи гуна аст» покупателю после заявки — «ройгон», вопрос агенту заметкой", () => {
    const [t] = dialog(ctx({ leadExists: true }), ["Ин роял ҳом шартҳояш чихел хизматрасонии чи гуна аст"], afterLead("buyer"));
    expect(t!.keys).toEqual(["buyer_free"]);
    expect(t!.text).toMatch(/ройгон/u);
    expect(t!.d.actions).toMatchObject([{ type: "append_note" }]);
  });
  it("то же продавцу — комиссия", () => {
    const [t] = dialog(ctx({ leadExists: true }), ["Шартҳоятон чихел?"], afterLead("seller"));
    expect(t!.keys).toEqual(["seller_commission"]);
  });
  it("п.15, db061eef: «Какие услуги вы предлагаете?» — сначала суть (без комиссии), потом вопрос о роли", () => {
    const [t] = dialog(IG(), ["Какие услуги вы предлагаете?"]);
    expect(t!.keys).toEqual(["services_intro", "ask_role"]);
    expect(t!.text).toMatch(/^Помогаем купить и продать недвижимость в Душанбе/u);
    expect(t!.text).not.toMatch(/%|комисси/u);
  });
  it("п.17, 71178348: реклама объекта №214 — «Сколько стоят ваши услуги?» → «для покупателя бесплатно»; «Можно фото/видео, адрес» — не повтор цены", () => {
    const focus = { propertyId: "6f1c2d3e-0000-4000-8000-000000000214", shortId: 214, priceText: { ru: "75 000 USD", tg: "75 000 USD" }, sold: false,
      place: "Сино, Душанбе" };
    const c = ctx({ ad: { topic: "property", propertyId: focus.propertyId }, focus });
    const [fee, photo] = dialog(c, ["Сколько стоят ваши услуги?", "Можно фото/видео, адрес"]);
    expect(fee!.keys).toContain("buyer_free");
    expect(fee!.text).toMatch(/бесплатн/u);
    expect(photo!.keys).toContain("photo_by_agent");
    expect(photo!.text).not.toMatch(/75 000 USD.*75 000 USD/u);
    expect(photo!.text).not.toBe(fee!.text);
  });
  it("58fa7438: «Чикоркардан даркор» после заявки — «делать ничего не нужно», а не «передал вопрос»", () => {
    const [t] = dialog(ctx({ leadExists: true }), ["Чикоркардан даркор"], afterLead("buyer"));
    expect(t!.keys).toEqual(["next_step"]);
  });
  it("7f2fa950: «ҳармоҳа супори», «бо банк харем» — честно: ипотеки и рассрочки нет", () => {
    const [first, second] = dialog(ctx(), ["Хонае ҳастай ки ҳармоҳа супори сумша мақсад", "Ё ягон хонаи тайёр ки бо банк харем"]);
    expect(first!.keys).toContain("no_installment");
    expect(first!.text).toMatch(/ипотека ва насия надорем/u);
    expect(first!.text).not.toMatch(/агенти мо мегӯяд/u);
    expect(second!.keys).not.toContain("no_installment"); // один раз за разговор
  });
  it("2cc65bc3: «хонаи фурушитон дар дохили шаҳри Душанбе ҳаст?» — «есть» и вопрос, что нужно", () => {
    const [t] = dialog(ctx(), ["Салом алекум хонаи фурушитон дар дохили шаҳри Душанбе ҳаст?"]);
    expect(t!.keys).toContain("stock_yes");
    expect(t!.keys).toContain("role_details_buyer");
    expect(t!.text).not.toMatch(/агенти мо мегӯяд/u);
    expect(leadsOf([t!])).toEqual([]);
  });
  it("c319ee90: голая ссылка на Reels — не «Это точно скажет агент»", () => {
    const [t] = dialog(IG(), ["https://www.instagram.com/reel/DgFstLfudEz/?evlk=and1cHYydzJ5aWZs"]);
    expect(t!.keys).not.toContain("details_by_agent");
  });
  it("7d0df9a4: «1 хонаги аз хучанд» (рассказ, не вопрос) — не «Инро аниқ агенти мо мегӯяд»", () => {
    const buyer = { ...initialOperatorState(), role: "buyer" as const, language: "tg" as const, asked: { role: 1, details: 1, phone: 0 } };
    const u = { ...understandFallback({ current: "1 хонаги аз хучанд" }, buyer, IG()), question: "other" as const };
    const d = decide(buyer, u, IG());
    expect(d.steps.map(s => s.key)).not.toContain("details_by_agent");
  });
});

describe("ревью #418: справки только на вопрос покупателя, фото — только просьба, общий список справок", () => {
  it("ипотека: «квартира в ипотеке» продавца и «нақд, бе кредит» — без справки; у продавца комиссия не теряется", () => {
    const [seller] = dialog(ctx(), ["Продаю квартиру, она в ипотеке"]);
    expect(seller!.keys).not.toContain("no_installment");
    expect(seller!.keys).toContain("seller_intro");
    const [cash] = dialog(IG(), ["Нақд мехарам, бе кредит"]);
    expect(cash!.keys).not.toContain("no_installment");
    const [ask] = dialog(IG(), ["Ипотека есть?"]);
    expect(ask!.keys).toContain("no_installment");
  });
  it("фото: «фото скину», «Аксия ҳаст?», «аксаран» — не просьба; голые «Фото?» и «Видео?» — просьба", () => {
    const [own] = dialog(ctx(), ["Мефурӯшам, фото скину"]);
    expect(own!.keys).not.toContain("photo_by_agent");
    for (const text of ["Аксия ҳаст?", "аксаран хонаҳо дар Сино"]) expect(dialog(IG(), [text])[0]!.keys, text).not.toContain("photo_by_agent");
    for (const text of ["Фото?", "Видео?"]) expect(dialog(IG(), [text])[0]!.keys, text).toContain("photo_by_agent");
  });
  it("суточный сброс знает новые справки (один список с decide.ts)", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    const state = { ...initialOperatorState(), spoken: { no_installment: 1, stock_yes: 1, services_intro: 1, buyer_free: 1 } };
    const stored = serializeOperatorState(state, new Date(now.getTime() - 25 * 3600_000));
    const read = readOperatorState(stored, now);
    for (const key of ["no_installment", "stock_yes", "services_intro", "buyer_free"] as const) expect(read.spoken[key], key).toBeUndefined();
  });
});

describe("п.13 сторож повтора своей реплики (9d656fe1: одна фраза о комиссии трижды подряд)", () => {
  it("тот же текст, что в прошлом ответе, — другой вариант фразы; оба уже звучали — тишина и сигнал человеку", () => {
    const step = { key: "seller_commission" as PhraseKey, vars: { percent: 2 }, variant: 0 };
    const said0 = renderOperatorStep(step, "tg"), said1 = renderOperatorStep({ ...step, variant: 1 }, "tg");
    const once = { steps: [step], language: "tg" as const, actions: [], silent: false };
    withoutOwnRepeats(once, [{ role: "assistant", text: said0 }]);
    expect(once.steps.map(s => s.variant)).toEqual([1]);
    const twice = { steps: [step], language: "tg" as const, actions: [] as never[], silent: false };
    withoutOwnRepeats(twice, [{ role: "assistant", text: said0 }, { role: "assistant", text: said1 }]);
    expect(twice.silent).toBe(true);
    expect(twice.actions).toEqual([{ type: "call_staff", reason: "repeat_question" }]);
  });
  it("сравнение — целыми предложениями, а не подстрокой (ревью #418)", () => {
    const step = { key: "got_it" as PhraseKey, vars: {}, variant: 1 };
    const said = renderOperatorStep(step, "ru"); // «Спасибо, понял.»
    const d = { steps: [step], language: "ru" as const, actions: [] as never[], silent: false };
    withoutOwnRepeats(d, [{ role: "assistant", text: `${said.slice(0, -1)}, это важно для агента.` }]);
    expect(d.steps).toEqual([step]);
  });
  it("ход с заявкой не глушится", () => {
    const step = { key: "lead_known_phone" as PhraseKey, vars: {}, variant: 0 };
    const said = renderOperatorStep(step, "ru");
    const d = { steps: [step], language: "ru" as const, actions: [{ type: "accept_lead" } as never], silent: false };
    withoutOwnRepeats(d, [{ role: "assistant", text: said }]);
    expect(d.steps).toHaveLength(1);
  });
});

describe("п.7–8 комментарии: продавцу не про наш объект; язык ответа = язык комментария", () => {
  it("464ca263, 5be84f3c: продавец по первому лицу или по своему номеру; покупатель с вопросом — нет (ревью #418)", () => {
    expect(customerPublicSellerOffer("ҳавли фуруши дорем да тарафи Гай балх станса ҳуҷатош 100% обу светаш ҳаст 10 сотиқ замин хоноҳош тайёр 884 83 66 00.")).toBe(true);
    expect(customerPublicSellerOffer("срочна ҳавли фуруши дорем да тарафи гай балх 10 сотиқ 884 83 66 00. 8888 016 71")).toBe(true);
    expect(customerPublicSellerOffer("Продаю 2-комнатную, 5 этаж, звоните")).toBe(true);
    expect(customerPublicSellerOffer("Хонаи фурӯшӣ доред?")).toBe(false);
    expect(customerPublicSellerOffer("Нархаш чанд?")).toBe(false);
    expect(customerPublicSellerOffer("Эта квартира продается?")).toBe(false);
    // Ревью #418: вопрос о цене — покупатель; цена из семи цифр — не телефон.
    expect(customerPublicSellerOffer("Хонаи фурӯшӣ 3 хонага Сино нархаш чанд")).toBe(false);
    expect(customerPublicSellerOffer("Продается 3 комн 80 кв сколько")).toBe(false);
    expect(customerPublicSellerOffer("Продается дом 1500000 сомони")).toBe(false);
    // 17b273e4 (без первого лица и без номера) по правилу ревью продавцом не считается — известный пробел.
    expect(customerPublicSellerOffer("ХОНАИ ФУРУШИ ЛАВИ РОХ 112МКР ПРЯМ БАРИ ПАЙКАР ДОМИ КОЛИНХОИ ФОРС 6 ЭТАЖ 68КВ РЕМОНТ КАДАГИ БА ХАМА ЧИЗОШ ТАЙЁР")).toBe(false);
  });
  it("рендер комментария продавца — без номера нашего объекта и без цены, с приглашением", () => {
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none" }, evidence: [], language: "tg",
      requestedFacts: [], surface: "public_comment", knownPhoneSource: "none", maxOutputChars: 1000,
      inputText: "ҳавли фуруши дорем да тарафи Гай балх 10 сотиқ замин 884 83 66 00" })!;
    expect(text).toMatch(/^Ташаккур! Барои фурӯши хонаатон/u);
    expect(text).not.toMatch(/№|нарх/u);
  });
  it("8b09ee8b: «Катлаванай» — таджикский; русские слова на «-ай» не трогаем", () => {
    expect(customerPublicLanguage("Катлаванай")).toBe("tg");
    expect(customerPublicLanguage("Давай")).toBe("ru");
    expect(customerPublicLanguage("Сарай")).toBe("ru");
    expect(customerPublicLanguage("Отдыхай")).toBe("ru");
    expect(customerPublicLanguage("Вспоминай")).toBe("ru");
  });
});

describe("п.14 петля a1af706a (11-13): на свежем main шаблоны не рождаются; п.7 de960ea6 — условие компании только на вопрос", () => {
  const knowledge = { version: 1, source: "AGENCY_FACTS", city: "Душанбе", otherCities: false,
    commission: { sellerPercent: 2, buyerPercent: 0 }, rent: false, installments: false, mortgage: false, botNamesDiscount: false, guarantees: false } as const;
  const sourceHash = customerAgentCompanyKnowledgeHash(knowledge as never);
  const policy = (topic: string) => ({ kind: "company_policy", topic, knowledge, sourceHash }) as never;
  const turns = [{ role: "user" as const, text: "Мехоҳам хонаамро фурӯшам" }, { role: "assistant" as const, text: "Барои хариду фурӯши хона дар Душанбе кӯмак мекунем." }];
  const render = (inputText: string, topic: string, surface: "dm" | "public_comment") => renderCustomerAgentDecision({
    decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" }, evidence: [{ ref: "e0", value: policy(topic) }], language: "tg",
    requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface, knowledgeSourceHash: sourceHash, inputText,
    verifiedContext: customerAgentVerifiedContextSchema.parse({ surface, revisionId: "a".repeat(64), turns, publicState: { language: "unknown", topic: "unknown", openQuestion: "none" } }) });
  it("«Ман да Душанбе», «Хона дар Душанбе аст» — без «Дар шаҳрҳои дигар кор намекунем» и без «Бори дигар такрор мекунам»", () => {
    for (const text of ["Ман да Душанбе", "Хона дар Душанбе аст", "Мехоҳам хонаамро фурӯшам"]) {
      const out = render(text, "service_scope", "dm") ?? "";
      expect(out, text).not.toMatch(/шаҳрҳои дигар|Бори дигар такрор/u);
    }
  });
  it("анкета продавца — без «Покии ҳуқуқии объектро кафолат дода наметавонам» (в переписке и в комментарии)", () => {
    for (const surface of ["dm", "public_comment"] as const) {
      expect(render("Хонаи 3 хонага, 5 этаж, 80 кв, ремонт, 90 000$", "legal", surface) ?? "", surface).not.toMatch(/кафолат|ҳуқуқ/u);
    }
  });
  it("находка 32: похвала «мутахасиси бехтарин» — по-таджикски спасибо, без «юридической чистоты»; на вопрос о документах — справка", () => {
    expect(customerPublicLanguage("мутахасиси бехтарин")).toBe("tg");
    const praise = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "thank", question: "none" },
      evidence: [{ ref: "e0", value: policy("legal") }], language: customerPublicLanguage("мутахасиси бехтарин"), requestedFacts: [],
      knownPhoneSource: "none", maxOutputChars: 4000, surface: "public_comment", knowledgeSourceHash: sourceHash, inputText: "мутахасиси бехтарин",
      verifiedContext: customerAgentVerifiedContextSchema.parse({ surface: "public_comment", revisionId: "a".repeat(64), turns: [],
        publicState: { language: "unknown", topic: "unknown", openQuestion: "none" } }) }) ?? "";
    expect(praise).not.toMatch(/юридическ|ҳуқуқ|кафолат|Спасибо/u);
    for (const surface of ["dm", "public_comment"] as const) {
      expect(render("Ҳуҷҷатҳояш тоза аст? Документы чистые?", "legal", surface) ?? "", surface).toMatch(/кафолат|ҳуқуқ/u);
    }
  });
  it("комментарий «Воаллекум салом» — без правила о торге", () => {
    expect(render("@royal.home.tj Воаллекум салом", "negotiation", "public_comment") ?? "").not.toMatch(/савдо|тахфиф/u);
  });
});

describe("п.11 вакансия (a4a672a5): клиент получает список отдельными строками; «склейка» — артефакт сборщика сторожа", () => {
  const positions = recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 }));
  const facts = { collecting: true, positions };
  const catalog = { kind: "open_vacancies" as const, ...facts, sourceHash: recruitmentCatalogHash(facts) };
  it("ru и tg: заголовок, каждое название и телефон — отдельные строки; название — точно как в каталоге (по нему память узнаёт список)", () => {
    for (const language of ["ru", "tg"] as const) {
      const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
        evidence: [{ ref: "e0", value: catalog }], language, requestedFacts: [], surface: "dm", knownPhoneSource: "none", maxOutputChars: 4000,
        inputText: language === "tg" ? "Ҷойи кор ҳаст?" : "Вакансии есть?" })!;
      const lines = text.split("\n");
      for (const p of positions) expect(lines, p.key).toContain(language === "tg" ? p.titleTg : p.titleRu);
    }
  });
});
