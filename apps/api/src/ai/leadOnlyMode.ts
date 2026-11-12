/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ОДНА ДВЕРЬ РЕШЕНИЙ ДЛЯ ОБОИХ МАРШРУТОВ БОТА
 * (владелец 12–13.11.2026, разбор 34 живых переписок: бот длинный, повторяется,
 * шлёт одни и те же три объекта, горячий покупатель «хотим посмотреть, куда ехать»
 * ушёл без звонка агента).
 *
 * Бот в этом режиме — вежливый администратор: одна-две короткие фразы, берёт
 * заявку и передаёт агенту. Подборок, фото, видео, ссылок и карточек нет.
 *
 * Здесь только ЧИСТЫЕ функции: какой сценарий у хода, что ответить, что вырезать
 * из уже готового ответа. Без базы, без модели, без времени «сейчас» внутри:
 * всё, что меняется (настройки, часы, найденные в базе цены), приходит
 * аргументами. Так одно и то же решение принимают и ядро
 * (lib/customerLeadOnlyCore.ts), и старый путь (messengers/conversation.ts), и
 * оно проверяется тестами без стенда.
 *
 * Цифры в ответе — только из аргументов (данные базы), сам модуль их не придумывает.
 */
import { BW, EW, TAIL } from "./wordBoundary.js";
import { customerRoleSignals } from "./customerAgentRole.js";
import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";
import { customerSearchIntent } from "./customerAgentSearchIntent.js";
import { clientOwnWords } from "./untrustedContent.js";
import { looksLikeRentRequest } from "./rentGuard.js";

export type LeadOnlyLanguage = "ru" | "tg";
export type LeadOnlyChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "WEBSITE" | string;

export interface LeadOnlyConfig {
  enabled: boolean;
  /** WhatsApp: номер отправителя и есть номер для звонка. */
  useWhatsappNumber: boolean;
  /** Instagram/Facebook: сколько раз всего просить номер (1..3). */
  maxPhoneAsks: number;
  /** Горячие слова → заявка агенту сразу. */
  hotIntentHandover: boolean;
  workHoursStart: string;
  workHoursEnd: string;
}

export const LEAD_ONLY_DEFAULTS: LeadOnlyConfig = Object.freeze({
  enabled: false, useWhatsappNumber: true, maxPhoneAsks: 2, hotIntentHandover: true,
  workHoursStart: "09:30", workHoursEnd: "18:00",
});

export function clampMaxPhoneAsks(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(3, Math.trunc(value as number))) : LEAD_ONLY_DEFAULTS.maxPhoneAsks;
}

// ── Горячие слова ───────────────────────────────────────────────────────────
// Кириллица: только BW/EW/TAIL (ai/wordBoundary.ts), никогда \w или \b.
const w = (body: string) => `${BW}(?:${body})${EW}`;
const HOT_PATTERNS: RegExp[] = [
  // «хотим/хочу/хотели бы посмотреть», «можно посмотреть», «приехать посмотреть»
  new RegExp(`${w(`хо(?:чу|тим|тел${TAIL}|тят)|можно|приехать|подъехать|давайте`)}(?:\\s+(?:бы|мы|ее|её|его|квартиру|дом|объект))*\\s+${w(`посмотреть|глянуть|увидеть`)}`, "iu"),
  // «куда ехать / подъехать / приезжать»
  new RegExp(`${w("куда")}\\s+${w(`ехать|подъехать|приехать|приезжать|подъезжать|идти`)}`, "iu"),
  // «когда можно приехать/посмотреть/подъехать»
  new RegExp(`${w("когда")}\\s+(?:${w("можно|сможем|могу|можем")}\\s+)?${w(`приехать|посмотреть|подъехать|встретиться|показ${TAIL}`)}`, "iu"),
  // «адрес» (не офиса: про офис отвечает обычный путь)
  new RegExp(`${w(`адрес${TAIL}`)}`, "iu"),
  // «мы реальные покупатели», «реальный покупатель», «готовы купить»
  new RegExp(`${w(`реальн${TAIL}|настоящ${TAIL}|серь[её]зн${TAIL}`)}\\s+${w(`покупател${TAIL}|клиент${TAIL}`)}`, "iu"),
  new RegExp(`${w(`готов${TAIL}`)}\\s+${w(`купить|брать|взять|покупать`)}`, "iu"),
  // ── таджикский (литературно и без спецбукв) ──
  // «дидан мехоҳем / мехоҳам», «тамошо кардан мехоҳем»
  new RegExp(`${w(`дидан${TAIL}|тамошо(?:\\s+кардан)?`)}\\s+${w(`мехо[ҳх]${TAIL}|мехоҳ${TAIL}`)}`, "iu"),
  // «куҷо биёем / равем / омадан», «кучо бием»
  new RegExp(`${w("куҷо|кучо")}\\s+${w(`би[ёе]${TAIL}|рав${TAIL}|омад${TAIL}|равем|биём`)}`, "iu"),
  // «кай омада метавонем», «кай биёем», «кай дидан мумкин»
  new RegExp(`${w("кай")}\\s+(?:${w(`омад${TAIL}|би[ёе]${TAIL}|дид${TAIL}|тамошо${TAIL}`)})`, "iu"),
  // «суроға», «суроғаш», «суроға(и) хона»
  new RegExp(`${w(`суро[ғг]${TAIL}`)}`, "iu"),
  // «харидори воқеӣ / аслӣ», «мо харидорем»
  new RegExp(`${w(`харидор${TAIL}`)}\\s+${w(`во[қк]е${TAIL}|асл${TAIL}|ҳақиқ${TAIL}|хакик${TAIL}`)}`, "iu"),
];
const OFFICE_WORD = new RegExp(w(`офис${TAIL}|дафтар${TAIL}|идора${TAIL}|компани${TAIL}|агентств${TAIL}`), "iu");

/** Клиент готов действовать: хочет посмотреть, спрашивает адрес, «куда ехать». */
export function leadOnlyHotIntent(text: string): boolean {
  const own = clientOwnWords(text).replaceAll("ё", "е").replaceAll("Ё", "Е");
  if (!own.trim()) return false;
  const hit = HOT_PATTERNS.some(pattern => pattern.test(own) || pattern.test(clientOwnWords(text)));
  if (!hit) return false;
  // «Адрес офиса» и «где ваш офис» — вопрос о компании, а не готовность ехать на объект.
  return !OFFICE_WORD.test(own);
}

// ── Сценарий хода ───────────────────────────────────────────────────────────
export type LeadOnlyScenario = "hot" | "property" | "seller" | "buyer";

export interface LeadOnlyScenarioInput {
  /** Слова клиента в этом ходе (вместе с буфером). */
  text: string;
  /** Объект определён сервером (ссылка, пост, реклама, картинка). */
  propertyKnown: boolean;
  /** Разговор уже о работе (вакансии ведёт Ноза — не трогаем). */
  jobTopic?: boolean;
  config: Pick<LeadOnlyConfig, "hotIntentHandover">;
}

/**
 * null — ход не про заявку (вопрос о компании, приветствие, вакансия, аренда):
 * его отвечает обычный путь бота, но тоже без подборок, фото и ссылок.
 */
export function leadOnlyScenario(input: LeadOnlyScenarioInput): LeadOnlyScenario | null {
  const own = clientOwnWords(input.text);
  if (!own.trim() || input.jobTopic || customerRecruitmentRequested(own)) return null;
  // Аренды у агентства нет: отказ — дело обычного пути (rentGuard / политика компании).
  if (looksLikeRentRequest(own)) return null;
  if (input.config.hotIntentHandover && leadOnlyHotIntent(own)) return "hot";
  if (input.propertyKnown) return "property";
  const signals = customerRoleSignals(own);
  if ((signals.sell || signals.landlord) && !signals.buyStrong) return "seller";
  if (signals.buyStrong || signals.buyWeak || customerSearchIntent(own)) return "buyer";
  return null;
}

// ── Тексты ──────────────────────────────────────────────────────────────────
const money = (amount: string, currency: string, language: LeadOnlyLanguage) =>
  `${amount.replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ${currency === "USD" ? "USD" : language === "tg" ? "сомонӣ" : "сомони"}`;

export interface LeadOnlyPropertyFacts { shortId: number; price: string | null; currency: string; sold: boolean }
export interface LeadOnlyMarketSummary { districtName: string | null; minPrice: string; currency: string }

/** Когда агент позвонит — честно: в рабочее время «скоро», вне его — со времени начала. */
export function leadOnlyCallbackWhen(input: { now: string; workHoursStart: string; workHoursEnd: string }):
  { kind: "soon" } | { kind: "today_from" | "tomorrow_from"; from: string } {
  const { now, workHoursStart: start, workHoursEnd: end } = input;
  const inside = start <= end ? now >= start && now < end : now >= start || now < end;
  if (inside) return { kind: "soon" };
  // До начала окна (раннее утро) — «сегодня с 09:30», после конца — «завтра утром».
  return start <= end && now < start ? { kind: "today_from", from: start } : { kind: "tomorrow_from", from: start };
}

export type LeadOnlyPhoneState =
  /** WhatsApp и рубильник «номер WhatsApp»: номер уже есть, не спрашиваем. */
  | { kind: "whatsapp" }
  /** Клиент сам дал номер (в этом ходе или раньше). */
  | { kind: "given" }
  /** Instagram/Facebook: номер ещё не дан; asksSoFar — сколько раз уже просили. */
  | { kind: "ask"; asksSoFar: number; maxAsks: number; officeAlreadyOffered: boolean };

export const LEAD_ONLY_OFFICE_PHONE_TEXT = "777 070 100";

const LINES = {
  hot: { ru: "Хорошо, передаю агенту.", tg: "Хуб, ба агент мерасонам." },
  hotProperty: { ru: (id: number) => `Хорошо, передаю агенту по объекту №${id}.`, tg: (id: number) => `Хуб, оид ба объекти №${id} ба агент мерасонам.` },
  seller: {
    ru: (pct: number) => `Да, поможем продать. Комиссия агентства ${pct}%, работаем по Душанбе.`,
    tg: (pct: number) => `Бале, дар фурӯш кӯмак мекунем. Комиссияи агентӣ ${pct}%, дар Душанбе кор мекунем.`,
  },
  propertyPrice: {
    ru: (id: number, m: string) => `Это объект №${id}, цена ${m}.`,
    tg: (id: number, m: string) => `Ин объекти №${id}, нархаш ${m}.`,
  },
  propertyNoPrice: { ru: (id: number) => `Это объект №${id}.`, tg: (id: number) => `Ин объекти №${id}.` },
  propertySold: {
    ru: (id: number) => `Объект №${id} уже продан, агент подскажет похожие.`,
    tg: (id: number) => `Объекти №${id} аллакай фурӯхта шуд, агент монандашро мегӯяд.`,
  },
  propertyUnknown: { ru: "Понял, о каком объекте речь.", tg: "Фаҳмидам, кадом объектро дар назар доред." },
  buyerDistrict: {
    ru: (d: string, m: string) => `Да, есть варианты в районе ${d} от ${m}. Агент подберёт и расскажет подробнее.`,
    tg: (d: string, m: string) => `Бале, дар ноҳияи ${d} вариантҳо ҳастанд, аз ${m}. Агенти мо интихоб карда, муфассал мегӯяд.`,
  },
  buyerAny: {
    ru: (m: string) => `Да, есть варианты от ${m}. Агент подберёт и расскажет подробнее.`,
    tg: (m: string) => `Бале, вариантҳо ҳастанд, аз ${m}. Агенти мо интихоб карда, муфассал мегӯяд.`,
  },
  buyerNone: {
    ru: "Подберём под ваш запрос, агент расскажет подробнее.",
    tg: "Мувофиқи дархостатон интихоб мекунем, агенти мо муфассал мегӯяд.",
  },
  escalate: { ru: "Передаю ваш вопрос агенту.", tg: "Саволатонро ба агент мерасонам." },
} as const;

function whenText(when: ReturnType<typeof leadOnlyCallbackWhen>, language: LeadOnlyLanguage): string {
  if (when.kind === "soon") return "";
  if (language === "tg") return when.kind === "today_from" ? `имрӯз аз соати ${when.from}` : `пагоҳ саҳар аз соати ${when.from}`;
  return when.kind === "today_from" ? `сегодня с ${when.from}` : `завтра утром, с ${when.from}`;
}

/** Строка про звонок/номер. null — номер просить больше нельзя и офис уже предлагали: молчим про номер. */
export function leadOnlyPhoneLine(phone: LeadOnlyPhoneState, when: ReturnType<typeof leadOnlyCallbackWhen>,
  language: LeadOnlyLanguage): string | null {
  const at = whenText(when, language);
  if (phone.kind === "whatsapp") {
    if (language === "tg") return at ? `Агент ${at} ба ҳамин рақам ба шумо занг мезанад, мувофиқ аст?` : "Агент ба ҳамин рақам ба шумо занг мезанад, мувофиқ аст?";
    return at ? `Агент позвонит вам на этот номер ${at}. Удобно?` : "Агент позвонит вам на этот номер, удобно?";
  }
  if (phone.kind === "given") {
    if (language === "tg") return at ? `Ташаккур, рақамро гирифтам. Агент ${at} занг мезанад.` : "Ташаккур, рақамро гирифтам. Агент ба зудӣ занг мезанад.";
    return at ? `Спасибо, номер получил. Агент позвонит ${at}.` : "Спасибо, номер получил. Агент скоро позвонит.";
  }
  if (phone.asksSoFar < phone.maxAsks) {
    if (phone.asksSoFar === 0) {
      return language === "tg" ? "Рақами телефонатонро нависед, то агент занг занад." : "Оставьте, пожалуйста, номер телефона, агент перезвонит.";
    }
    return language === "tg" ? "Агар мувофиқ бошад, рақаматонро нависед, агент худаш занг мезанад."
      : "Если удобно, напишите номер, и агент позвонит сам.";
  }
  if (phone.officeAlreadyOffered) return null;
  return language === "tg" ? `Хуб, бемалол. Агар хоҳед, худатон ба мо занг занед: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`
    : `Хорошо, без проблем. Если захотите, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`;
}

/** Все строки-просьбы номера (для подсчёта, сколько раз уже просили). */
export function leadOnlyPhoneAskLines(): string[] {
  return ["Оставьте, пожалуйста, номер телефона, агент перезвонит.", "Если удобно, напишите номер, и агент позвонит сам.",
    "Рақами телефонатонро нависед, то агент занг занад.", "Агар мувофиқ бошад, рақаматонро нависед, агент худаш занг мезанад."];
}

/** Сколько раз бот уже просил номер и предлагал ли номер офиса — по своим прежним репликам. */
export function leadOnlyPhoneAskHistory(assistantTexts: readonly string[]): { asksSoFar: number; officeAlreadyOffered: boolean } {
  const asks = leadOnlyPhoneAskLines();
  // Прежние просьбы номера обычным путём бота тоже считаются (шаблон ядра и вольные фразы старого пути).
  const generic = new RegExp(`(?:номер${TAIL}\\s+телефон|оставьте\\s+(?:ваш\\s+|свой\\s+)?номер|напишите\\s+(?:ваш\\s+|свой\\s+)?номер|рақам${TAIL}(?:\\s+\\S+){0,2}\\s+нависед|рақам${TAIL}\\s+мегузоред)`, "iu");
  let asksSoFar = 0, officeAlreadyOffered = false;
  for (const text of assistantTexts) {
    if (asks.some(line => text.includes(line)) || generic.test(text)) asksSoFar++;
    if (text.includes(LEAD_ONLY_OFFICE_PHONE_TEXT)) officeAlreadyOffered = true;
  }
  return { asksSoFar, officeAlreadyOffered };
}

export interface LeadOnlyReplyInput {
  scenario: LeadOnlyScenario | "escalate";
  language: LeadOnlyLanguage;
  phone: LeadOnlyPhoneState;
  when: ReturnType<typeof leadOnlyCallbackWhen>;
  /** Объект из базы (сценарий 2 и горячие слова по объекту). */
  property?: LeadOnlyPropertyFacts | null;
  /** Сценарий 3: минимальная цена из базы, без неё — без цифр. */
  market?: LeadOnlyMarketSummary | null;
  /** Комиссия продавца из фактов агентства (ai/agencyFacts.ts). */
  sellerCommissionPercent: number;
}

/** Готовый короткий ответ: одна фраза по сути и одна про звонок. Без ссылок, списков и придуманных цифр. */
export function leadOnlyReply(input: LeadOnlyReplyInput): string {
  const lang = input.language, p = input.property;
  let intro: string;
  switch (input.scenario) {
    case "hot": intro = p ? LINES.hotProperty[lang](p.shortId) : LINES.hot[lang]; break;
    case "seller": intro = LINES.seller[lang](input.sellerCommissionPercent); break;
    case "property":
      intro = !p ? LINES.propertyUnknown[lang] : p.sold ? LINES.propertySold[lang](p.shortId)
        : p.price ? LINES.propertyPrice[lang](p.shortId, money(p.price, p.currency, lang)) : LINES.propertyNoPrice[lang](p.shortId);
      break;
    case "buyer": {
      const m = input.market;
      intro = m && Number(m.minPrice) > 0
        ? m.districtName ? LINES.buyerDistrict[lang](m.districtName, money(m.minPrice, m.currency, lang)) : LINES.buyerAny[lang](money(m.minPrice, m.currency, lang))
        : LINES.buyerNone[lang];
      break;
    }
    default: intro = LINES.escalate[lang];
  }
  const phoneLine = leadOnlyPhoneLine(input.phone, input.when, lang);
  return [intro, phoneLine].filter(Boolean).join(" ").replaceAll("—", ",");
}

// ── Фильтр ответа в коде (второй слой запрета) ──────────────────────────────
const URL_LINE = /(?:https?:\/\/|www\.|royalhome\.tj|instagram\.com|facebook\.com|wa\.me|t\.me\/)/iu;
const CARD_LINE = /№\s?\d+/u;
const PRICE_WORD = /(?:USD|\$|сомон|сомонӣ|TJS)/iu;
const LIST_MARK = /^\s*(?:\d{1,2}[.)]|[-•*▪️🏠🏡🔹🔸])\s*/u;

/**
 * Второй слой запрета: что бы ни написал обычный путь, ссылки и подборка
 * объектов из ответа уходят. Подборка — две и больше строк с номером объекта и
 * ценой либо пунктами списка с номером объекта. Возвращает очищенный текст и
 * признак, что резали (вызвавший решает, отправить остаток или короткий шаблон).
 */
export function leadOnlyFilterReply(text: string): { text: string; changed: boolean } {
  const lines = text.split("\n");
  const cardLines = lines.filter(line => CARD_LINE.test(line) && (PRICE_WORD.test(line) || LIST_MARK.test(line)));
  const isList = cardLines.length >= 2;
  const kept = lines.filter(line => !URL_LINE.test(line) && !(isList && CARD_LINE.test(line)));
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, changed: cleaned !== text.trim() };
}
