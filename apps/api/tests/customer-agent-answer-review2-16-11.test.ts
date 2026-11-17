import { describe, expect, it } from "vitest";
import { customerAgentAnswerVerdict, renderCustomerAgentDecision, customerAgentSentQuestion } from "../src/ai/customerAgentRenderer.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerAgentHumanLineSafe } from "../src/ai/customerAgentAnswer.js";
import { customerSellerAskedTerms } from "../src/ai/customerAgentSellerGuard.js";
import { informalAddress } from "../src/ai/customerAgentHumanText.js";

/**
 * Re-review of #211 (16.11.2026, HEAD 81f0df50): ~150 bypass attempts of the word blacklist, 74 passed + 9 place names
 * (review-211/apps/api/tmp-review/probe2.ts, probe3.ts). Round 2 replaced the blacklist by an ALLOWLIST: every case below is the
 * probe's own input and must now reach the customer as the template (only the approved question wordings pass).
 */
const hash = "a".repeat(64);
const facts = (o: Record<string, unknown> = {}) => ({ propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS",
  availability: "AVAILABLE", publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null, publicLink: null,
  updatedAt: "2026-10-15T00:00:00.000Z", signature: hash, ...o });
const knowledge = readCustomerAgentCompanyKnowledge(), kh = customerAgentCompanyKnowledgeHash(knowledge);
const base = { knownPhoneSource: "none" as const, maxOutputChars: 2000, surface: "dm" as const, knowledgeSourceHash: kh };
type Case = { language?: "ru" | "tg"; inputText: string; requestedFacts?: string[]; d: Record<string, unknown>; evidence?: unknown[]; prior?: string[] };
const inp = (o: Case, answer?: unknown) => ({ ...base, language: o.language ?? "ru", inputText: o.inputText, requestedFacts: o.requestedFacts ?? [], evidence: o.evidence ?? [],
  decision: { ...o.d, ...(answer === undefined ? {} : { answer }) },
  ...(o.prior ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" }, turns: o.prior.map(text => ({ role: "assistant", text })) } } : {}) }) as never;
const pol = (topic: string) => [{ ref: "e0", value: { kind: "company_policy", topic, knowledge, sourceHash: kh } }];
const reply = (refs: string[], question = "none", social = "none") => ({ kind: "reply", refs, social, question });
const cl = (question: string, social = "none") => ({ kind: "clarify", refs: [], social, question });
const price = [{ ref: "e0", value: { kind: "facts", facts: facts(), kinds: ["price"] } }];
const sold = [{ ref: "e0", value: { kind: "facts", facts: facts({ availability: "SOLD" }), kinds: ["price"] } }];
const C: Record<string, Case> = {
  priceRu: { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  soldRu: { inputText: "Цена объекта 123?", requestedFacts: ["price"], d: reply(["e0"]), evidence: sold },
  soldTg: { language: "tg", inputText: "Нархи объекти 123 чанд?", requestedFacts: ["price"], d: reply(["e0"]), evidence: sold },
  priceTg: { language: "tg", inputText: "Нархи объекти 123 чанд?", requestedFacts: ["price"], d: reply(["e0"]), evidence: price },
  zoneRu: { inputText: "Вы работаете в Худжанде?", d: reply(["e0"]), evidence: pol("service_scope") },
  zoneTg: { language: "tg", inputText: "Дар Хуҷанд кор мекунед?", d: reply(["e0"]), evidence: pol("service_scope") },
  rentRu: { inputText: "Вы сдаёте квартиры в аренду?", d: reply(["e0"]), evidence: pol("rental") },
  rentTg: { language: "tg", inputText: "Шумо хона ба иҷора медиҳед?", d: reply(["e0"]), evidence: pol("rental") },
  comRu: { inputText: "Какая у вас комиссия?", d: reply(["e0"], "role"), evidence: pol("commission") },
  comTg: { language: "tg", inputText: "Комиссияи шумо чанд аст?", d: reply(["e0"], "role"), evidence: pol("commission") },
  roomsRu: { inputText: "Ищу квартиру", d: cl("rooms") },
  budgetTg: { language: "tg", inputText: "Хона мехарам", d: cl("budget") },
  locRu: { inputText: "Ищу квартиру", d: cl("location") },
  locTg: { language: "tg", inputText: "Хона мехарам", d: cl("location") },
  cbRu: { inputText: "Хочу купить квартиру", d: cl("callback_consent") },
  cbTg: { language: "tg", inputText: "Хона мехарам", d: cl("callback_consent") },
  nameRu: { inputText: "Хочу купить квартиру", d: cl("name") },
};
/** Probe2 inputs that are approved question wordings: these are the only probe cases that may pass. */
/** «zero width»: the invisible character is removed by normalization, so the customer reads the plain vetted «Понимаю вас.». */
const APPROVED = new Set(["cb ask tg", "name ask", "zero width"]);

describe("re-review #211 probe2: no bypass reaches the customer (allowlist)", () => {
  it.each([
  ["avail ru актуально", C.soldRu, { lead: "Предложение пока актуально." }],
  ["avail ru доступен", C.soldRu, { lead: "Этот вариант доступен для просмотра." }],
  ["avail ru успейте", C.soldRu, { lead: "Успейте посмотреть." }],
  ["avail ru ушла", C.priceRu, { lead: "Эту квартиру уже забрали." }],
  ["avail tg холӣ", C.soldTg, { lead: "Ин хона ҳоло холӣ." }],
  ["avail tg дастрас", C.soldTg, { lead: "Ин хона дастрас." }],
  ["avail tg дастрас аст", C.soldTg, { lead: "Ин хона ҳанӯз дастрас аст." }],
  ["avail tg харидор ёфт", C.priceTg, { lead: "Ин хона харидорашро ёфт." }],
  ["rent ru посуточно", C.rentRu, { lead: "Посуточно тоже можно." }],
  ["rent ru посуточно 2", C.rentRu, { lead: "Квартиры посуточно подбираем." }],
  ["rent ru внаём", C.rentRu, { lead: "Жильё внаём тоже ищем для клиентов." }],
  ["rent ru съём", C.rentRu, { lead: "Со съёмом жилья поможем." }],
  ["rent ru квартирантов", C.rentRu, { lead: "Квартирантов находим быстро." }],
  ["rent tg ичора plain", C.rentTg, { lead: "Ичора ҳам мешавад." }],
  ["rent tg кироянишин", C.rentTg, { lead: "Барои кироянишин хона пайдо мекунам." }],
  ["zone ru Худжанд lowercase", C.zoneRu, { lead: "Понимаю, в худжанде помочь можем." }],
  ["zone ru по всему Таджикистану lc", C.zoneRu, { lead: "Понимаю, работаем по всему таджикистану." }],
  ["zone ru первое слово", C.zoneRu, { lead: "Худжанд нам знаком." }],
  ["zone ru Согд", C.zoneRu, { lead: "Понимаю вас, и в согдийской области помогу." }],
  ["zone tg Хуҷанд lc", C.zoneTg, { lead: "Фаҳмидам, дар хуҷанд ҳам ёрӣ расонида метавонам." }],
  ["zone tg first word", C.zoneTg, { lead: "Хуҷанд барои мо ҷои ошност." }],
  ["zone tg Кӯлоб", C.zoneTg, { lead: "Фаҳмидам, мо дар кӯлоб низ кор карда метавонем." }],
  ["zone ru Вахдат first", C.zoneRu, { lead: "Вахдат тоже наш." }],
  ["help ru помогу", C.rentRu, { lead: "С этим я вам помогу." }],
  ["help ru поможем", C.rentRu, { lead: "Поможем и с этим." }],
  ["help tg кӯмак мекунам", C.rentTg, { lead: "Дар ин бобат кӯмак карда метавонам." }],
  ["can ru сможем", C.zoneRu, { lead: "Сможем и там." }],
  ["can ru возможно", C.rentRu, { lead: "Это возможно." }],
  ["can ru получится", C.rentRu, { lead: "Думаю, получится." }],
  ["can tg мумкин", C.rentTg, { lead: "Ин мумкин аст." }],
  ["can tg мешавад", C.rentTg, { lead: "Ин кор шуданист." }],
  ["latin", C.priceRu, { lead: "Ok, ponyal." }],
  ["homoglyph a", C.priceRu, { lead: "Понимаю, это нaш вариант." }],
  ["greek", C.priceRu, { lead: "Понимаю, Ω." }],
  ["fullwidth digits", C.priceRu, { lead: "Цена １２３." }],
  ["roman numeral", C.priceRu, { lead: "Это Ⅻ этаж." }],
  ["cyrillic digit-letters", C.priceRu, { lead: "Понимаю, зэ двушка." }],
  ["ru сто тысяч", C.priceRu, { lead: "Можно и за сто тысяч." }],
  ["ru полтора ляма", C.priceRu, { lead: "Отдадут за полтора ляма." }],
  ["ru пару", C.priceRu, { lead: "Пару вариантов подберу." }],
  ["ru второй этаж", C.priceRu, { lead: "Понимаю, это второй этаж." }],
  ["ru двушка", C.priceRu, { lead: "Понимаю, это двушка." }],
  ["ru трёшка", C.roomsRu, { lead: "Трёшки сейчас в цене." }],
  ["ru половина", C.priceRu, { lead: "Половину можно позже." }],
  ["ru вдвое", C.priceRu, { lead: "Это вдвое дешевле." }],
  ["ru дешевле", C.priceRu, { lead: "Понимаю, это дешевле рынка." }],
  ["tg сад ҳазор", C.priceTg, { lead: "Бо сад ҳазор ҳам мешавад." }],
  ["tg сад ҳазор 2", C.priceTg, { lead: "Фаҳмидам, сад ҳазор кифоя аст." }],
  ["tg дусад", C.priceTg, { lead: "Фаҳмидам, дусад кифоя." }],
  ["tg як миллион", C.priceTg, { lead: "Фаҳмидам, як миллион кифоя." }],
  ["tg нисф", C.priceTg, { lead: "Фаҳмидам, нисфашро баъд." }],
  ["tg арзон", C.priceTg, { lead: "Фаҳмидам, ин арзонтар аз бозор." }],
  ["tg ду ҳуҷра", C.priceTg, { lead: "Фаҳмидам, хонаи духуҷрагӣ." }],
  ["ru нельзя", C.priceRu, { lead: "Торговаться тут нельзя." }],
  ["ru никогда", C.priceRu, { lead: "Такое никогда не бывает." }],
  ["ru отсутствует", C.priceRu, { lead: "Понимаю, задолженность отсутствует." }],
  ["ru без долгов", C.priceRu, { lead: "Понимаю, квартира без долгов." }],
  ["ru невозможно", C.rentRu, { lead: "Понимаю, это невозможно." }],
  ["tg не", C.priceTg, { lead: "Фаҳмидам, қарз надорад." }],
  ["tg набуд", C.priceTg, { lead: "Фаҳмидам, ин хона мушкил надошт." }],
  ["tg ҳеҷ", C.priceTg, { lead: "Фаҳмидам, ҳеҷ мушкил нест." }],
  ["tg ҳеҷ 2", C.priceTg, { lead: "Фаҳмидам, ҳеҷ мушкиле дида намешавад." }],
  ["tg ғайриимкон", C.rentTg, { lead: "Фаҳмидам, ин ғайриимкон." }],
  ["ru бесплатно", C.comRu, { lead: "Для вас бесплатно." }],
  ["ru даром", C.comRu, { lead: "Для покупателей это ничего не стоит." }],
  ["ru платить не нужно", C.comRu, { lead: "Покупателю платить ничего не нужно." }],
  ["ru без оплаты", C.comRu, { lead: "Для покупателей без оплаты." }],
  ["tg бепул", C.comTg, { lead: "Барои харидор бепул." }],
  ["tg ройгон", C.comTg, { lead: "Барои шумо ройгон." }],
  ["tg бе пул", C.comTg, { lead: "Барои харидор бе пул." }],
  ["tg пардохт лозим", C.comTg, { lead: "Харидор чизе пардохт намекунад." }],
  ["tg мафт", C.comTg, { lead: "Барои харидор мафт." }],
  ["tg текин", C.comTg, { lead: "Барои харидор текин." }],
  ["tg имрӯз", C.cbTg, { lead: "Фаҳмидам, имрӯз ҳал мешавад." }],
  ["tg имрӯз 2", C.cbTg, { ask: "Мехоҳед, ки корманд имрӯз ба шумо занг занад?" }],
  ["tg пагоҳ", C.cbTg, { ask: "Мехоҳед, ки корманд пагоҳ ба шумо занг занад?" }],
  ["tg зуд", C.cbTg, { ask: "Мехоҳед, ки корманд зуд ба шумо занг занад?" }],
  ["tg ҳозир", C.cbTg, { ask: "Мехоҳед, ки корманд ҳозир ба шумо занг занад?" }],
  ["tg баъдтар", C.cbTg, { ask: "Мехоҳед, ки корманд баъдтар ба шумо занг занад?" }],
  ["ru сейчас", C.cbRu, { ask: "Хотите, чтобы сотрудник позвонил вам прямо сейчас?" }],
  ["ru скоро", C.cbRu, { ask: "Хотите, чтобы сотрудник скоро вам позвонил?" }],
  ["ru быстро", C.cbRu, { ask: "Хотите, чтобы сотрудник быстро вам перезвонил?" }],
  ["ru в течение", C.cbRu, { ask: "Хотите, чтобы сотрудник вам позвонил в течение часа?" }],
  ["ru оперативно", C.cbRu, { ask: "Хотите, чтобы сотрудник оперативно вам позвонил?" }],
  ["ru немедленно lead", C.roomsRu, { lead: "Сразу подберём.", ask: "Сколько комнат вам нужно?" }],
  ["ru в любое время close", C.priceRu, { close: "Пишите в любое время." }],
  ["ru круглосуточно close", C.priceRu, { close: "Мы на связи круглосуточно." }],
  ["tg ҳар вақт close", C.priceTg, { close: "Ҳар вақт навишта метавонед." }],
  ["ru ждём в гости close", C.priceRu, { close: "Ждём вас в гости." }],
  ["ru приходите close", C.priceRu, { close: "Приходите посмотреть." }],
  ["ru звоните close", C.priceRu, { close: "Звоните, если что." }],
  ["tg дори (-и not -ӣ)", C.budgetTg, { ask: "Чанд пул дори?" }],
  ["tg бигу (у not ӯ)", C.budgetTg, { lead: "Фаҳмидам.", ask: "Бигу, чӣ қадар маблағ дар назар дори?" }],
  ["tg мехари", C.budgetTg, { ask: "Бо чӣ қадар маблағ хона мехари?" }],
  ["tg доштӣ", C.budgetTg, { ask: "Чӣ қадар маблағ доштӣ?" }],
  ["tg хостӣ", C.budgetTg, { ask: "Чӣ қадар маблағ сарф кардан мехостӣ?" }],
  ["tg бигӯ-чӣ", C.budgetTg, { ask: "Бигӯ-чӣ, маблағ чӣ қадар?" }],
  ["tg шав", C.budgetTg, { lead: "Хурсанд шав.", ask: "Маблағ чӣ қадар дар назар доред?" }],
  ["tg биёр", C.budgetTg, { lead: "Ҳуҷҷатҳоро биёр." }],
  ["tg кун-ед ok", C.budgetTg, { ask: "Маблағро муайян кунед?" }],
  ["tg фикр кун", C.budgetTg, { lead: "Хуб фикр кун." }],
  ["tg розӣ?", C.cbTg, { ask: "Розӣ, ки корманд занг занад?" }],
  ["tg ту hidden: худат", C.budgetTg, { ask: "Маблағро худатон гуфта метавонед?" }],
  ["ru скажи-ка", C.roomsRu, { ask: "Скажи-ка, сколько комнат нужно?" }],
  ["ru поделись", C.roomsRu, { ask: "Поделись, сколько комнат нужно?" }],
  ["ru определился", C.locRu, { ask: "Уже определился с районом?" }],
  ["ru нашёл", C.locRu, { ask: "Нашёл подходящий район?" }],
  ["ru спроси", C.roomsRu, { lead: "Спроси у семьи.", ask: "Сколько комнат нужно?" }],
  ["ru опиши", C.roomsRu, { ask: "Опиши, сколько комнат надо?" }],
  ["ru хотел бы", C.roomsRu, { ask: "Сколько комнат хотел бы?" }],
  ["ru ищешь", C.roomsRu, { ask: "Сколько комнат ищешь?" }],
  ["ru ну-ка", C.roomsRu, { ask: "Ну-ка, сколько комнат надо?" }],
  ["ru дружище", C.roomsRu, { lead: "Понял, дружище.", ask: "Сколько комнат нужно?" }],
  ["ru брат", C.roomsRu, { lead: "Понял, брат.", ask: "Сколько комнат нужно?" }],
  ["tg бародар", C.budgetTg, { lead: "Фаҳмидам, бародар.", ask: "Чӣ қадар маблағ дар назар доред?" }],
  ["tg ака", C.budgetTg, { lead: "Фаҳмидам, ака.", ask: "Чӣ қадар маблағ дар назар доред?" }],
  ["emoji", C.priceRu, { lead: "Понимаю вас 🙂" }],
  ["emoji heart", C.priceRu, { lead: "Понимаю ❤" }],
  ["markdown bold", C.priceRu, { lead: "**Понимаю** вас." }],
  ["markdown underscore", C.priceRu, { lead: "_Понимаю_ вас." }],
  ["zero width", C.priceRu, { lead: "Пони​маю вас." }],
  ["quotes", C.priceRu, { lead: "Понимаю, «свободна»." }],
  ["ru рада сообщить + sold", C.soldRu, { lead: "Спешу вас обрадовать." }],
  ["ru поздравляю + sold", C.soldRu, { lead: "Поздравляю с выбором." }],
  ["ru вам повезло + sold", C.soldRu, { lead: "Вам повезло." }],
  ["ru успели + sold", C.soldRu, { lead: "Вы как раз вовремя." }],
  ["ru не переживайте + rent no", C.rentRu, { lead: "Понимаю, это частый вопрос." }],
  ["ru с удовольствием + rent no", C.rentRu, { lead: "С удовольствием отвечу." }],
  ["ru ура", C.zoneRu, { lead: "Ура, вы по адресу." }],
  ["ru по адресу", C.zoneRu, { lead: "Вы обратились по адресу." }],
  ["ru правильно выбрали", C.zoneRu, { lead: "Вы правильно сделали, что написали нам." }],
  ["tg хушхабар", C.soldTg, { lead: "Барои шумо хабари хуш." }],
  ["tg бахти шумо", C.soldTg, { lead: "Бахти шумо омад." }],
  ["tg хурсанд", C.soldTg, { lead: "Хурсандем, ки навиштед." }],
  ["ru buyer pays? lead", C.comRu, { lead: "Понимаю, вопрос оплаты важен.", ask: "Вы хотите купить или продать недвижимость?" }],
  ["ru role ask contradicts", C.comRu, { ask: "Вы продаёте или покупаете?" }],
  ["ru close after facts", C.priceRu, { close: "Хороших вам просмотров." }],
  ["ru close с выбором", C.soldRu, { close: "Удачи с выбором." }],
  ["lead with implicit question", C.roomsRu, { lead: "Интересно, сколько вам нужно.", ask: "Сколько комнат вам нужно?" }],
  ["lead request", C.roomsRu, { lead: "Напишите мне подробнее.", ask: "Сколько комнат вам нужно?" }],
  ["lead request tg", C.budgetTg, { lead: "Маълумот диҳед.", ask: "Чӣ қадар маблағ дар назар доред?" }],
  ["close as request", C.priceRu, { close: "Напишите, если интересно." }],
  ["close as request 2", C.priceRu, { close: "Жду вашего ответа." }],
  ["ask two topics", C.roomsRu, { ask: "Сколько комнат и какой этаж нужен?" }],
  ["ask two topics 2", C.roomsRu, { ask: "Сколько комнат вам нужно и на какой бюджет?" }],
  ["ask other topic sneak", C.roomsRu, { ask: "Сколько комнат вам нужно для семьи из пяти?" }],
  ["loc ask: город", C.locRu, { ask: "В каком городе вы ищете?" }],
  ["loc ask tg: шаҳр", C.locTg, { ask: "Дар кадом шаҳр хона мекобед?" }],
  ["loc ask: где удобно", C.locRu, { ask: "Где вам было бы удобно жить?" }],
  ["cb ask announce", C.cbRu, { ask: "Можно, сотрудник вам позвонит?" }],
  ["cb ask or write", C.cbRu, { ask: "Хотите, чтобы сотрудник вам позвонил или написал?" }],
  ["cb ask other person", C.cbRu, { ask: "Можно позвонить вашему мужу?" }],
  ["cb ask tg", C.cbTg, { ask: "Мехоҳед, ки корманди мо ба шумо занг занад?" }],
  ["name ask", C.nameRu, { ask: "Как я могу к вам обращаться?" }],
  ["greet lead no template greet", C.priceRu, { lead: "Добрый день!" }],
  ["repeat lead next turn", { ...C.priceRu, prior: ["Понимаю вас.\nОбъект №123: 1 250 000 сомонӣ."] }, { lead: "Понимаю вас." }],
  ["near-repeat lead next turn", { ...C.priceRu, prior: ["Понимаю вас.\nx"] }, { lead: "Понимаю вас!" }],
  ["near-repeat 2", { ...C.priceRu, prior: ["Хорошо, понимаю вас.\nx"] }, { lead: "Понимаю вас, хорошо." }],
  ] as Array<[string, Case, unknown]>)("%s", (name, c, answer) => {
    const v = customerAgentAnswerVerdict(inp(c, answer)) as { ok: boolean; text?: string } | null;
    if (APPROVED.has(name)) { expect(v?.ok, name).toBe(true); expect(v?.text ?? "").not.toMatch(/[\p{Cf}]/u); return; }
    expect(v?.ok, `${name}: ${JSON.stringify(v)}`).toBe(false);
    expect(renderCustomerAgentDecision(inp(c, answer))).toBe(renderCustomerAgentDecision(inp(c)));
  });
});

describe("re-review #211 probe3: place names in Tajik and small towns", () => {
  it.each([["tg", "Фаҳмидам, хуҷанд."], ["tg", "Фаҳмидам, дар истаравшан."], ["tg", "Фаҳмидам, панҷакент."], ["tg", "Фаҳмидам, кӯлоб."], ["tg", "Фаҳмидам, турсунзода."],
    ["ru", "Понимаю, истаравшан."], ["ru", "Понимаю, пенджикент."], ["ru", "Истаравшан нам близок."], ["tg", "Истаравшан барои мо наздик."], ["ru", "Понимаю, хорог."]] as const)(
    "%s %s", (language, lead) => {
      const v = customerAgentAnswerVerdict({ ...base, language, inputText: "?", requestedFacts: [], evidence: pol("service_scope"),
        decision: { kind: "reply", refs: ["e0"], social: "none", question: "none", answer: { lead } } } as never);
      expect(v?.ok).toBe(false);
    });
});

describe("approved call question = consent; any other wording = no marker", () => {
  it("the approved Tajik and Russian call questions are recorded", () => {
    for (const [c, ask] of [[C.cbRu, "Хотите, чтобы сотрудник вам позвонил?"], [C.cbTg, "Мехоҳед, ки корманди мо ба шумо занг занад?"]] as const) {
      const input = inp(c, { ask }), text = renderCustomerAgentDecision(input)!;
      expect(text.endsWith(ask)).toBe(true);
      expect(customerAgentSentQuestion(input, text)).toBe("callback_consent");
    }
  });
  it("a time, another person, another channel or an announcement is not the call question: template, no marker for the model words", () => {
    for (const ask of ["Хотите, чтобы сотрудник позвонил вам прямо сейчас?", "Можно, сотрудник вам позвонит?", "Можно позвонить вашему мужу?",
      "Хотите, чтобы сотрудник вам позвонил или написал?", "Хотите, чтобы сотрудник скоро вам позвонил?"]) {
      const input = inp(C.cbRu, { ask });
      expect(renderCustomerAgentDecision(input)).toBe(renderCustomerAgentDecision(inp(C.cbRu)));
      expect(customerAgentSentQuestion(input, `Хорошо.\n${ask}`)).toBe("none");
    }
    for (const ask of ["Мехоҳед, ки корманд ҳозир ба шумо занг занад?", "Мехоҳед, ки корманд зуд ба шумо занг занад?"]) {
      const input = inp(C.cbTg, { ask });
      expect(customerAgentSentQuestion(input, `Фаҳмидам.\n${ask}`)).toBe("none");
    }
  });
});

describe("seller terms: a question, never a description (re-review #211, п.7)", () => {
  const seller = { intake: { role: "seller", sellerKnown: [], buyerKnown: [] }, turns: [] } as never;
  it.each([["Чи шарту шароит доред?", true], ["Чи шарту шароит доред", true], ["Какие у вас условия?", true], ["Шарти шумо барои харидор чӣ?", true],
    ["Продаю квартиру, все условия есть", false], ["Хонаамро мефурӯшам, ҳама шароит дорад", false], ["Квартира в хорошем состоянии, условия хорошие", false],
    ["Хонаи 3 ҳуҷрагӣ, шароиташ хуб", false], ["Продаю, условия обсудим при встрече", false]] as const)("%s → %s", (text, expected) => {
    expect(customerSellerAskedTerms({ inputText: text, verifiedContext: seller })).toBe(expected);
  });
});

describe("dialogue memory admits only vetted lines; «ты» forms are caught explicitly", () => {
  it.each([["Понимаю вас.", true], ["Хотите, чтобы сотрудник вам позвонил?", true], ["Сколько комнат хочешь?", false], ["Ҳа, мо кор мекунем.", false],
    ["Чанд пул дори?", false], ["Скажи-ка, сколько комнат нужно?", false]] as const)("memory %s → %s", (line, safe) => {
    expect(customerAgentHumanLineSafe(line)).toBe(safe);
  });
  it.each([["tg", "Чанд пул дори?"], ["tg", "Бигу, чӣ қадар маблағ дар назар дори?"], ["tg", "Бо чӣ қадар маблағ хона мехари?"], ["tg", "Чӣ қадар маблағ доштӣ?"],
    ["tg", "Бигӯ-чӣ, маблағ чӣ қадар?"], ["tg", "Хурсанд шав."], ["tg", "Ҳуҷҷатҳоро биёр."], ["tg", "Хуб фикр кун."], ["tg", "Фаҳмидам, бародар."],
    ["ru", "Скажи-ка, сколько комнат нужно?"], ["ru", "Поделись, сколько комнат нужно?"], ["ru", "Уже определился с районом?"], ["ru", "Нашёл подходящий район?"],
    ["ru", "Спроси у семьи."], ["ru", "Опиши, сколько комнат надо?"], ["ru", "Сколько комнат хотел бы?"], ["ru", "Ну-ка, сколько комнат надо?"],
    ["ru", "Понял, дружище."], ["ru", "Понял, брат."]] as const)("«ты» %s %s", (language, text) => {
    expect(informalAddress(text, language)).not.toBeNull();
  });
  it("polite forms and «ака» are not «ты»", () => {
    for (const text of ["Как вы определились с районом?", "Вы уже нашли подходящий район?", "Понял вас."]) expect(informalAddress(text, "ru"), text).toBeNull();
    for (const text of ["Фаҳмидам, ака.", "Чӣ қадар маблағ дар назар доред?", "Раҳмат барои меҳрубонӣ."]) expect(informalAddress(text, "tg"), text).toBeNull();
  });
});
