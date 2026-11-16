import type { CustomerAgentAnswerDropReason, CustomerAgentSurface } from "@royal-home/shared";
import { clientOwnWords } from "./untrustedContent.js";
import { detectClientLanguage } from "./clientLanguage.js";
import { findBannedWords } from "./bannedWordsGuard.js";
import { findOffCatalogClaims } from "./catalogClaimsGuard.js";
import { normalizeSayText, SAY_LEXICON, foldSayText, foldSayPattern, sayWordStem, sayTokens, sayComparable, sayEchoes } from "./customerAgentSay.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * WHOLE REPLY WRITTEN BY THE MODEL, VERIFIED BY THE SERVER (one-brain plan 16.11.2026, step 1).
 *
 * The model writes the complete customer reply in its own warm words (`answer`). The server renders its template reply from
 * the same verified evidence as before and uses it as the REFERENCE: the model's text may rephrase it, but every number,
 * price/currency, phone, object number, place, Latin word, promise and business claim (availability, commission, rent,
 * zone, renovation, legal, salary...) must be backed by that template, the tool evidence of this turn or — for plain
 * numbers only — the customer's own words; every price, phone and object number of the template must survive.
 * The verdict is ALL OR NOTHING: the text is never cut or repaired. Any doubt and the template reply goes out unchanged.
 *
 * Pure and deterministic like customerAgentSay.ts: the core verifies once, the renderer verifies again from the same inputs,
 * and the delivery seal re-renders the identical text. No clock, randomness, database or network may ever enter this file.
 */
export const ANSWER_MAX_CHARS = 700;
export const ANSWER_MAX_SENTENCES = 7;
export const ANSWER_MAX_LINES = 6;
/** Russian and Tajik both (owner 16.11.2026: «Почему умному боту запрещено своими словами говорить?»). */
export const ANSWER_ENABLED_LANGUAGES: readonly ("ru" | "tg")[] = ["ru", "tg"];

/** Phrases shown to the model. Tests run every one through the validator against a plain template, so guidance never teaches a dropped phrase. */
export const CUSTOMER_AGENT_ANSWER_EXAMPLES = {
  ru: ["Понимаю, вы ищете квартиру для семьи. Подскажите, в каком районе вам удобнее?",
    "Спасибо, что написали. На какую сумму вы рассчитываете?"],
  tg: ["Ваалайкум ассалом! Фаҳмидам, шумо хона меҷӯед. Дар кадом ноҳия бошад, беҳтар аст?",
    "Раҳмат, ки навиштед. Бемалол бигӯед, чӣ қадар маблағ дар назар доред?"],
} as const;

/**
 * The rules for the optional `answer` field. They ride in the per-turn server context (`serverSurface.answerGuidance`, private
 * messages only), never in the pinned system prompt: a changed prompt hash cannot ride the routine «Обновить версию бота» path
 * (lib/customerAgentOwnerPolicy.ts, lib/customerAgentAutoRefresh.ts PINNED_FIELDS). This text is hashed with the renderer files.
 */
export const CUSTOMER_AGENT_ANSWER_GUIDANCE = `Исключение из «не добавляй произвольный текст»: в reply, clarify и propose можно (и желательно) добавить поле answer — весь ответ клиенту твоими словами на языке replyLanguage.
Сервер сам соберёт ответ по шаблону из тех же фактов и сверит с ним answer. Если сверка пройдена, клиент прочтёт твой answer, иначе уйдёт шаблон. Сервер не правит и не режет answer.
Как писать answer:
- тепло и вежливо, как живой агент агентства недвижимости в Душанбе: только «вы» (по-таджикски «шумо», глаголы во множественном числе), коротко, до 5 предложений, без списков, звёздочек и тире;
- сначала ответ на вопрос клиента, затем не больше одного вопроса; задавай тот же вопрос, что выбрал в поле question (question=none — без вопроса);
- цены, номера объектов, адреса, телефоны, проценты, сроки и условия бери только из результатов инструментов этого хода, цифрами, с той же валютой; не добавляй того, чего нет в результатах;
- если в результатах есть цена, телефон или номер объекта, которые отвечают на вопрос, они должны быть в answer;
- не обещай действий без receipt («позвоним», «запишу», «проверю», «подберу»), не называй сроки и имена сотрудников;
- никогда: «я уже писал выше», «повторяю», «как я говорил», «дар боло навиштам», «бори дигар такрор мекунам», «заявка сохранена», «ваше обращение зарегистрировано», «я бот», ИИ, CRM, refs;
- по-таджикски живо и по-разговорному: «Ассалому алейкум!» / «Ваалайкум ассалом!», «Раҳмат», «бемалол», «агенти мо»; без «лутфан», «безаҳмат», «мутахассис», «амвол», «муфассал», «хоҳиш мекунем», без русских слов, если клиент пишет по-таджикски;
- не здоровайся повторно, не пересказывай слова клиента, не повторяй свои прежние ответы.
Примеры answer на русском:
${CUSTOMER_AGENT_ANSWER_EXAMPLES.ru.join("\n")}
Примеры answer на таджикском:
${CUSTOMER_AGENT_ANSWER_EXAMPLES.tg.join("\n")}`;

export type CustomerAgentAnswerVerdict = { ok: true; text: string } | { ok: false; reason: Exclude<CustomerAgentAnswerDropReason, "shadow"> };
export interface CustomerAgentAnswerInput {
  answer: unknown;
  /** The server's own reply for the same decision and evidence (template). null/empty = nothing to verify against. */
  template: string | null;
  language: "ru" | "tg";
  surface: CustomerAgentSurface;
  inputText?: string;
  /** Every observation of this turn (public projection is enough); receipts in the decision refs unlock call/save words. */
  evidence: readonly unknown[];
  selectedReceipts?: readonly string[];
  priorAssistantTurns?: readonly string[];
  maxOutputChars: number;
  /** The decision asked the planner for a file: the template carries that notice, the model cannot. */
  attachment?: boolean;
  enabledLanguages?: readonly ("ru" | "tg")[];
}

const f = foldSayText;
const rx = (source: string) => new RegExp(foldSayPattern(source), "iu");
const rxg = (source: string) => new RegExp(foldSayPattern(source), "giu");
const w = (alternatives: string) => rx(`${BW}(?:${alternatives})${EW}`);
const INVISIBLE = /[\p{Cf}­᠎︀-️]/gu;
const TAJIK_LETTER = /[қғҳҷӣӯҚҒҲҶӢӮ]/u;

// ── tone: the live bad replies of the audit 16.11.2026 (tone.md, language.md) ──────────────────────────────────────────
/** «Писал выше / повторяю / бори дигар такрор мекунам / агар саволи ман дар боло номафҳум буд» — 96 replies in 5 days. */
const REPEAT_RUDE = w([`писал${TAIL}\\s+выше`, `написал${TAIL}\\s+выше`, `уже\\s+(?:писал${TAIL}|написал${TAIL}|ответил${TAIL}|говорил${TAIL}|сказал${TAIL}|объяснял${TAIL})`,
  "повтор(?:ю|яю|юсь|яюсь|ю\\s+ещ[её]\\s+раз)", `как\\s+я\\s+(?:уже\\s+)?(?:писал${TAIL}|сказал${TAIL}|говорил${TAIL})`, `(?:читайте|смотрите|см\\.?)\\s+выше`,
  `дар\\s+боло`, `боло\\s+навишт${TAIL}`, `такрор\\s+мекун${TAIL}`, `бозам\\s+такрор`, `номафҳум\\s+буд${TAIL}`, `агар\\s+саволи\\s+ман`].join("|"));
/** Service receipts and system talk instead of a person: «Заявка на связь с сотрудником сохранена.», «На изображении вижу: ...». */
const RECEIPT_TALK = rx(`${BW}(?:заявк${TAIL}[^.!?\\n]{0,60}(?:сохранен${TAIL}|зарегистрир${TAIL}|создан${TAIL}|принят${TAIL})|(?:ваш${TAIL}\\s+)?(?:запрос|обращени${TAIL})[^.!?\\n]{0,40}(?:сохранен${TAIL}|зарегистрир${TAIL}|принят${TAIL})|на\\s+изображении\\s+вижу|в\\s+подтвержд[её]нных\\s+данных|данн${TAIL}\\s+(?:нет|отсутству${TAIL})\\s+в\\s+систем${TAIL})${EW}`);
/** Bookish and machine Tajik the owner banned (tajik-phrasebook do-not-say, owner 16.08/17.09/11.11.2026). */
const WOODEN_TG = w([`лутфан`, `безаҳмат`, `безахмат`, `мутахассис${TAIL}`, `амвол${TAIL}`, `муфассал${TAIL}`, `хоҳиш\\s+мекун${TAIL}`, `ёрӣ\\s+медиҳ${TAIL}`, `қулай${TAIL}`, `мудир${TAIL}`, `линк${TAIL}`,
  `муҳтарам\\s+мизоҷ${TAIL}`, `мизоҷи\\s+муҳтарам`].join("|"));
const INFORMAL_RU = w("ты|тебе|тебя|тобой|тобою|твой|твоя|твоё|твое|твои|твоего|твоей|твоему|твоих|твоим|твоими");
const INFORMAL_TG = w("ту|туро|ба\\s+ту|аз\\s+ту|бо\\s+ту|барои\\s+ту|худат|ҳастӣ|медонӣ|мехоҳӣ|нависӣ|гӯй|бигӯй");
/** Owner rule: no dash inside phrases (tajik-phrasebook do-not-say №14); a line that starts with a dash is a list. */
const DASH = /—|(?<!\d)–|–(?!\d)|(?:^|\n)\s*[-•]\s/u;
const POLITE_CAPITALS = new Set(["вы", "вас", "вам", "вами", "ваш", "ваша", "ваше", "ваши", "вашего", "вашей", "вашу", "вашим", "ваших", "шумо", "шумоед"].map(f));

// ── claims that only a verified line may carry ───────────────────────────────────────────────────────────────────────
/** A class in the answer needs the same class in the template (the server's verified line). */
const CLAIM_CLASSES: readonly { name: string; pattern: RegExp }[] = [
  { name: "availability", pattern: w(`продан${TAIL}|продал${TAIL}|брон${TAIL}|забронир${TAIL}|свободн${TAIL}|свободен|в\\s+наличии|фурӯхта${TAIL}|озод${TAIL}|мавҷуд${TAIL}|занят${TAIL}`) },
  { name: "commission", pattern: rx(`${BW}(?:комисси${TAIL}|процент${TAIL}|фоиз${TAIL}|ҳаққи\\s+хизмат${TAIL})${EW}|%`) },
  { name: "rent", pattern: w(`аренд${TAIL}|снять|сдать|сдаем|сда[её]т${TAIL}|кироя${TAIL}|иҷора${TAIL}`) },
  { name: "credit", pattern: w(`ипотек${TAIL}|рассрочк${TAIL}|кредит${TAIL}|насия${TAIL}|қарз${TAIL}|бо\\s+қисм${TAIL}`) },
  { name: "discount", pattern: w(`скидк${TAIL}|торг${TAIL}|уступ${TAIL}|тахфиф${TAIL}|арзон\\s+мекун${TAIL}`) },
  { name: "coverage", pattern: w(`друг${TAIL}\\s+город${TAIL}|город${TAIL}\\s+не\\s+обслужива${TAIL}|не\\s+работаем|не\\s+обслуживаем|только\\s+в\\s+душанбе|шаҳрҳои\\s+дигар|кор\\s+намекун${TAIL}|фақат\\s+дар`) },
  { name: "legal", pattern: w(`юридическ${TAIL}|юридик${TAIL}|чистот${TAIL}|ҳуқуқ${TAIL}|покии`) },
  { name: "renovation", pattern: w(`ремонт${TAIL}|евроремонт${TAIL}|таъмир${TAIL}|коробк${TAIL}|каробка${TAIL}|чернов${TAIL}|белая\\s+отделк${TAIL}`) },
  { name: "furniture", pattern: w(`мебел${TAIL}|мебл${TAIL}|ҷиҳоз${TAIL}`) },
  { name: "salary", pattern: w(`зарплат${TAIL}|оклад${TAIL}|маош${TAIL}|музд${TAIL}|оплата\\s+труда`) },
  { name: "address", pattern: w(`адрес${TAIL}|суроға${TAIL}|офис${TAIL}|улиц${TAIL}|проспект${TAIL}|кӯча${TAIL}|хиёбон${TAIL}`) },
  { name: "time", pattern: w(`сегодня|завтра|послезавтра|вечером|утром|через\\s+(?:час|день|неделю|пару)\\p{L}*|в\\s+течение|до\\s+конца\\s+дня|имрӯз|фардо|пагоҳ${TAIL}|бегоҳ${TAIL}|баъд\\s+аз|соат${TAIL}|понедельник${TAIL}|вторник${TAIL}|сред[аыу]|четверг${TAIL}|пятниц${TAIL}|суббот${TAIL}|воскресень${TAIL}|душанбе\\s+рӯз|якшанбе|шанбе|ҷумъа`) },
  { name: "builder", pattern: w(`застройщик${TAIL}|сохтмонч${TAIL}|ширкати\\s+сохтмон${TAIL}`) },
  { name: "person", pattern: w(`ноза${TAIL}|риелтор${TAIL}|директор${TAIL}|руководител${TAIL}|роп`) },
];
const CURRENCY_TOKEN = `(?:сомон${TAIL}|сом|смн|tjs|долл?ар${TAIL}|usd|руб${TAIL}|евро|\\$|€|₽)`;
const currencyClass = (token: string): string => {
  const t = f(token);
  if (/^(?:сомон|сом|смн|tjs)/u.test(t)) return "TJS";
  if (/^(?:дол|usd|\$)/u.test(t)) return "USD";
  if (/^(?:руб|₽)/u.test(t)) return "RUB";
  return "EUR";
};
/** Spelled-out quantities carry an unverifiable figure («сто тысяч», «панҷ ҳазор»); «один/як» are speech, not facts. */
const SPELLED_NUMBER = w([`дв[аеу]`, "двух", "двум", "двумя", "три", "трех", "трем", "тремя", `четыр${TAIL}`, `пят(?:ь|и|ью)`, `шест(?:ь|и|ью)`, "семь", "семи", `восем${TAIL}`, `девят${TAIL}`, `десят${TAIL}`,
  `\\p{L}*надцат${TAIL}`, `двадцат${TAIL}`, `тридцат${TAIL}`, "сорок", "сорока", `пятьдесят${TAIL}`, `шестьдесят${TAIL}`, `семьдесят${TAIL}`, `восемьдесят${TAIL}`, "девяносто", "сто", "ста", `сотн${TAIL}`,
  "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот", `тысяч${TAIL}`, "тыс", `миллион${TAIL}`, `млн`, `миллиард${TAIL}`, `полтор${TAIL}`,
  "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт", "нӯҳ", "даҳ", "бист", "чил", "панҷоҳ", "шаст", "ҳафтод", "ҳаштод", "навад", "сад", "ҳазор", `миллион${TAIL}`].join("|"));
/** A question sentence about the phone number: allowed only when the server itself asks for it this turn. */
const PHONE_ASK = w(`номер${TAIL}|телефон${TAIL}|рақам${TAIL}|ватсап${TAIL}|вотсап${TAIL}|whatsapp|контакт${TAIL}`);
/** Asking for or naming the customer's phone outside a question sentence too («Оставьте ваш номер телефона.»). */
const PHONE_REQUEST = w(`телефон${TAIL}|ватсап${TAIL}|вотсап${TAIL}|whatsapp|ваш${TAIL}\\s+номер${TAIL}|номер${TAIL}\\s+(?:для\\s+связи|телефона)|рақам${TAIL}`);
/** The question topic must be the server's question topic (the next state machine step is recorded from `question`). */
const QUESTION_TOPICS: readonly RegExp[] = [
  w(`бюджет${TAIL}|сумм${TAIL}|стоимост${TAIL}|цен${TAIL}|рассчитыва${TAIL}|буҷет${TAIL}|маблағ${TAIL}|нарх${TAIL}|пул${TAIL}`),
  w(`район${TAIL}|ноҳия${TAIL}|мавзе${TAIL}|ҷой${TAIL}|где|куда|куҷо|микрорайон${TAIL}|мкр`),
  w(`комнат${TAIL}|ҳуҷра${TAIL}|хонаг${TAIL}|комнатн${TAIL}`),
  PHONE_ASK,
  w(`зовут|имя|имени|ном${TAIL}|номатон`),
  w(`позвонить|созвон${TAIL}|звонок|звонка|занг${TAIL}`),
  w(`объект${TAIL}|квартир${TAIL}|ссылк${TAIL}|вариант${TAIL}|хона${TAIL}|манзил${TAIL}|эълон${TAIL}|объявлени${TAIL}`),
  w(`опыт${TAIL}|работ${TAIL}|таҷриба${TAIL}|кор${TAIL}|ваканси${TAIL}|портфолио|программ${TAIL}|барнома${TAIL}`),
  w(`купить|продать|харид${TAIL}|фурӯш${TAIL}|покупк${TAIL}|продаж${TAIL}`),
];

// ── numbers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Digit groups with thousands separators («1 250 000», «123 456.78») or a plain run; phones keep all their digits. */
const NUMBER = /(?<![\p{L}\d])(\+?\d[\d   \-()]*\d|\d)(?:[.,](\d{1,2}))?(?![\d])/gu;
interface Num { canon: string; digits: string; index: number; end: number }
function canonical(intDigits: string, decimal?: string): string {
  const dec = decimal && /[1-9]/u.test(decimal) ? `.${decimal.replace(/0+$/u, "")}` : "";
  return `${intDigits.replace(/^0+(?=\d)/u, "")}${dec}`;
}
/** Splits a run on separators that are not thousands grouping: «2 3» are two numbers, «1 250 000» is one, a phone is one. */
function numbersOf(text: string): Num[] {
  const out: Num[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const raw = match[1];
    const phoneLike = raw.startsWith("+") || raw.replace(/\D/gu, "").length >= 9 && /[\s\-()]/u.test(raw);
    const grouped = /^\d{1,3}(?:[   ]\d{3})+$/u.test(raw);
    if (phoneLike || grouped || /^\d+$/u.test(raw)) {
      const digits = raw.replace(/\D/gu, "");
      out.push({ canon: canonical(digits, phoneLike ? undefined : match[2]), digits, index: match.index!, end: match.index! + match[0].length });
      continue;
    }
    // «5 этаж 9» never reaches here (letters stop the run); «2 3» or «10-15» are separate figures.
    let offset = match.index!;
    for (const part of raw.split(/([   \-()]+)/u)) {
      if (/^\d+$/u.test(part)) out.push({ canon: canonical(part), digits: part, index: offset, end: offset + part.length });
      offset += part.length;
    }
  }
  return out;
}
/** Every figure of a JSON evidence value (strings and numbers alike: price "1250000", digits "992446501414", "10:00"). */
function evidenceNumbers(evidence: readonly unknown[]): Set<string> {
  const set = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) { for (const n of numbersOf(String(value))) set.add(n.canon); return; }
    if (typeof value === "string") { for (const n of numbersOf(value)) set.add(n.canon); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  evidence.forEach(walk);
  return set;
}
/** (amount, currency) pairs: «1 250 000 сомонӣ», «$ 85 000», and verified {price, currency} objects of the evidence. */
function pricePairs(text: string): Set<string> {
  const pairs = new Set<string>();
  for (const n of numbersOf(text)) {
    const after = text.slice(n.end).match(rx(`^\\s{0,2}${CURRENCY_TOKEN}${EW}`)) ?? text.slice(n.end).match(/^\s{0,2}[$€₽]/u);
    const before = text.slice(Math.max(0, n.index - 3), n.index).match(/[$€₽]\s{0,2}$/u);
    if (after) pairs.add(`${n.canon}|${currencyClass(after[0].trim())}`);
    else if (before) pairs.add(`${n.canon}|${currencyClass(before[0].trim())}`);
  }
  return pairs;
}
function evidencePricePairs(evidence: readonly unknown[]): Set<string> {
  const pairs = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.price === "string" && (record.currency === "TJS" || record.currency === "USD")) {
      const [int, dec] = record.price.split(".");
      pairs.add(`${canonical(int, dec)}|${record.currency}`);
    }
    Object.values(record).forEach(walk);
  };
  evidence.forEach(walk);
  return pairs;
}
function evidenceAddresses(evidence: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.publicAddress === "string" && record.publicAddress.trim()) out.push(record.publicAddress.trim());
    Object.values(record).forEach(walk);
  };
  evidence.forEach(walk);
  return out;
}
const isPercent = (text: string, n: Num) => /^\s{0,2}(?:%|процент|фоиз)/iu.test(text.slice(n.end));
const isObjectNumber = (text: string, n: Num) => /(?:№|#)\s{0,2}$/u.test(text.slice(Math.max(0, n.index - 3), n.index));
const isPhone = (n: Num) => n.digits.length >= 7 && !n.canon.includes(".");

const sentencesOf = (text: string) => text.split(/(?<=[.!?…])\s+|\n+/u).map(s => s.trim()).filter(s => /\p{L}/u.test(s));
const questionSentences = (text: string) => sentencesOf(text).filter(s => /[?？]\s*$/u.test(s) || /[?？]/u.test(s));
const evidenceText = (evidence: readonly unknown[]) => { try { return JSON.stringify(evidence); } catch { return ""; } };
const sourceWords = (...texts: string[]) => f(texts.join("\n"));

/** Identifiers, signatures and links are not facts a customer reads: their digits must never "verify" a figure («3» of a UUID). */
const PRIVATE_KEY = /(?:^id$|Id$|^ref$|signature|link|url|hash|key|token|uuid|fence)/iu;
function publicFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicFacts);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !PRIVATE_KEY.test(key)).map(([key, item]) => [key, publicFacts(item)]));
}

/** All-or-nothing verdict. The first failing rule names the reason; the text is never repaired. */
export function validateCustomerAgentAnswer(given: CustomerAgentAnswerInput): CustomerAgentAnswerVerdict {
  const input = { ...given, evidence: given.evidence.map(publicFacts) };
  const bad = (reason: Exclude<CustomerAgentAnswerDropReason, "shadow">): CustomerAgentAnswerVerdict => ({ ok: false, reason });
  if (input.surface !== "dm") return bad("surface_disabled");
  if (!(input.enabledLanguages ?? ANSWER_ENABLED_LANGUAGES).includes(input.language)) return bad("language_disabled");
  const template = input.template ?? "";
  if (!template.trim()) return bad("not_eligible");
  // Links, @handles and file notices are server payload the model never sees: the template keeps them (plan: step 1b appends them).
  if (input.attachment || /https?:\/\/|www\.|@\p{L}/iu.test(template)) return bad("template_payload");
  if (typeof input.answer !== "string") return bad("length");
  // NFKC turns «№» into «No» (Latin letters, then the object number is no longer a number): keep the sign through normalization.
  const NUMERO = "";
  const raw = input.answer.replace(/№/gu, NUMERO).normalize("NFKC").replace(INVISIBLE, "");
  const lines = raw.split(/\r?\n/u).map(line => normalizeSayText(line).replaceAll(NUMERO, "№")).filter(Boolean);
  const text = lines.join("\n");
  if (text.length < 2 || text.length > Math.min(ANSWER_MAX_CHARS, input.maxOutputChars) || lines.length > ANSWER_MAX_LINES ||
      sentencesOf(text).length > ANSWER_MAX_SENTENCES) return bad("length");
  const folded = f(text), templateFolded = f(template);
  const own = clientOwnWords(input.inputText ?? "");
  const evidenceJson = evidenceText(input.evidence);

  // Tone first: these are the replies the owner called «деревянный», «жёстко, грубо».
  if (REPEAT_RUDE.test(folded) || RECEIPT_TALK.test(folded)) return bad("wooden");
  if (WOODEN_TG.test(folded) || findBannedWords(text).length || DASH.test(text)) return bad("wooden");
  if (input.language === "ru" ? INFORMAL_RU.test(folded) : INFORMAL_TG.test(folded)) return bad("rude");
  if (SAY_LEXICON.META.test(folded) && !SAY_LEXICON.META.test(templateFolded)) return bad("meta");
  if (SAY_LEXICON.CLICHE.test(folded)) return bad("cliche");

  // One question at most, and the same topic the server asks (the state machine records `question`).
  const asked = questionSentences(text), templateAsked = questionSentences(template);
  if (asked.length > 1 || (text.match(/[?？]/gu)?.length ?? 0) > 1) return bad("question");
  if (templateAsked.length === 0 && asked.length) return bad("question");
  if (templateAsked.length && !asked.length) return bad("question");
  if (asked.length) {
    const a = f(asked[0]), t = f(templateAsked.at(-1)!);
    if (PHONE_ASK.test(a) && !PHONE_ASK.test(t)) return bad("phone_ask");
    const sameTopic = QUESTION_TOPICS.some(topic => topic.test(a) && topic.test(t));
    const sharedStem = sayTokens(a).filter(word => word.length >= 5).some(word => t.includes(word.slice(0, Math.max(4, word.length - 2))));
    if (!sameTopic && !sharedStem) return bad("question");
  }

  if (PHONE_REQUEST.test(folded) && !PHONE_REQUEST.test(templateFolded)) return bad("phone_ask");

  // Promises: only a receipt of this decision or the server's own line unlocks them.
  const receipts = new Set(input.selectedReceipts ?? []);
  const callUnlocked = receipts.has("callback_requested") || receipts.has("handover_requested") || SAY_LEXICON.CALL_PROMISE.test(templateFolded);
  const saveUnlocked = receipts.has("contact_saved") || receipts.has("job_application_saved") || SAY_LEXICON.SAVE_PROMISE.test(templateFolded);
  if (SAY_LEXICON.CALL_PROMISE.test(folded) && !callUnlocked || SAY_LEXICON.SAVE_PROMISE.test(folded) && !saveUnlocked) return bad("promise");
  const promiseWords = (value: string) => [...value.matchAll(new RegExp(SAY_LEXICON.ALWAYS_PROMISE.source, "giu"))].map(m => m[0].slice(0, 5));
  const templatePromises = new Set(promiseWords(templateFolded));
  if (promiseWords(folded).some(word => !templatePromises.has(word))) return bad("promise");
  if ((receipts.has("callback_requested") || receipts.has("handover_requested")) && !SAY_LEXICON.CALL_PROMISE.test(folded) &&
      !w(`агент${TAIL}|менеджер${TAIL}|менеҷер${TAIL}|сотрудник${TAIL}|корманд${TAIL}|передал${TAIL}|супоридам|додам`).test(folded)) return bad("missing_fact");

  // Business claims: the class must already be in the verified template.
  for (const claim of CLAIM_CLASSES) if (claim.pattern.test(folded) && !claim.pattern.test(templateFolded)) return bad("claim");

  // Numbers: spelled figures are unverifiable; digits must come from the template, the evidence or (plain figures only) the customer.
  if (SPELLED_NUMBER.test(folded)) return bad("number");
  const answerNumbers = numbersOf(text), templateNumbers = numbersOf(template);
  const verified = new Set([...templateNumbers.map(n => n.canon), ...evidenceNumbers(input.evidence)]);
  const customer = new Set(numbersOf(own).map(n => n.canon));
  const verifiedPhones = [...verified].filter(value => value.length >= 7 && !value.includes("."));
  const answerPairs = pricePairs(text), allowedPairs = new Set([...pricePairs(template), ...evidencePricePairs(input.evidence)]);
  const pricedNumbers = new Set([...answerPairs].map(pair => pair.split("|")[0]));
  for (const n of answerNumbers) {
    if (isPhone(n)) { if (!verifiedPhones.some(phone => phone === n.canon || n.canon.length >= 9 && phone.endsWith(n.canon))) return bad("number"); continue; }
    if (pricedNumbers.has(n.canon) || isPercent(text, n) || isObjectNumber(text, n)) { if (!verified.has(n.canon)) return bad("number"); continue; }
    if (!verified.has(n.canon) && !customer.has(n.canon)) return bad("number");
  }
  for (const pair of answerPairs) if (!allowedPairs.has(pair)) return bad("currency");
  // Off-catalog area/floor/street/price claims: the existing shared guard (chat + voice), against the verified sources.
  const off = findOffCatalogClaims({ text, allowedText: `${template}\n${evidenceJson}`, catalogText: `${template}\n${evidenceJson}`, clientText: own });
  if (off.prices.length || off.areas.length || off.floors.length) return bad("number");
  if (off.streets.length) return bad("place");
  // Nothing the template carries may be lost: prices, phones and object numbers of the verified reply survive.
  const answerCanon = new Set(answerNumbers.map(n => n.canon));
  for (const n of templateNumbers) {
    const required = isPhone(n) || isObjectNumber(template, n) || [...pricePairs(template)].some(pair => pair.startsWith(`${n.canon}|`)) ||
      receipts.size > 0 && !isPercent(template, n);
    if (required && !answerCanon.has(n.canon)) return bad("missing_fact");
  }

  // The verified address the template gives must survive too (at least one of its words).
  for (const address of evidenceAddresses(input.evidence)) {
    if (!templateFolded.includes(f(address))) continue;
    const words = sayTokens(address).filter(word => word.length >= 4).map(sayWordStem);
    if (words.length && !words.some(stem => folded.includes(stem))) return bad("missing_fact");
  }

  // Places, names and Latin words: only those the template, the evidence or the customer already wrote.
  const sources = sourceWords(template, own, evidenceJson);
  if (SAY_LEXICON.KNOWN_PLACES.some(place => place.pattern.test(folded) && !sources.includes(place.stem))) return bad("place");
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+/u)) {
    for (const [index, word] of sayTokens(sentence).entries()) {
      if (/\p{Script=Latin}/u.test(word)) { if (!sources.includes(f(word))) return bad("place"); continue; }
      if (index === 0 || word.length < 3) continue;
      const first = word[0];
      if (first === first.toLowerCase() || first !== first.toUpperCase() || POLITE_CAPITALS.has(f(word))) continue;
      if (!sources.includes(sayWordStem(word))) return bad("place");
    }
  }

  // Language: the customer's language, one language, Tajik with Tajik letters.
  const verdict = detectClientLanguage(text);
  const wrongLanguage = input.language === "ru"
    ? verdict === "tg" || verdict === "mixed" || TAJIK_LETTER.test(text)
    : verdict === "ru" || verdict === "mixed" || !TAJIK_LETTER.test(text);
  if (wrongLanguage) return bad("language");

  // Never the same reply twice, never the customer's own words back, one greeting per conversation.
  const key = sayComparable(text), prior = input.priorAssistantTurns ?? [];
  if (prior.some(turn => { const old = sayComparable(turn); return !!key && (old === key || key.length >= 20 && old.includes(key)); })) return bad("repeat");
  const last = prior.at(-1);
  if (last) {
    const lastKeys = new Set(sentencesOf(last).map(sayComparable).filter(s => s.length >= 20));
    const long = sentencesOf(text).map(sayComparable).filter(s => s.length >= 20);
    if (long.length && long.filter(s => lastKeys.has(s)).length * 2 >= long.length) return bad("repeat");
  }
  if (sayEchoes(text, own)) return bad("echo");
  if (SAY_LEXICON.GREETING.test(folded) && !SAY_LEXICON.GREETING.test(templateFolded)) return bad("double_greet");
  return { ok: true, text };
}
