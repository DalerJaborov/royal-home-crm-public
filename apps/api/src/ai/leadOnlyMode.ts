/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ОДНА ДВЕРЬ РЕШЕНИЙ ДЛЯ ОБОИХ МАРШРУТОВ БОТА
 * (владелец 12–13.11.2026, разбор 34 живых переписок: бот длинный, повторяется,
 * шлёт одни и те же три объекта, горячий покупатель «хотим посмотреть, куда ехать»
 * ушёл без звонка агента).
 *
 * С 19.11.2026 (этап 1.2) ход в режиме целиком ведёт оператор приёма заявок (ai/operator): шаги, роли и ВСЕ
 * тексты клиенту — там. Здесь остались общие части режима, ЧИСТЫЕ функции без базы и модели: в каких каналах режим
 * действует, его настройки по умолчанию, горячие слова и отказ от звонка (запасные правила оператора), время звонка
 * по рабочим часам, вопрос о цене услуг, фильтры чужого текста (ссылки и подборки, просьба номера в WhatsApp) и
 * последняя дверь текста режима (`leadOnlyOutgoing`). Прежние шаблоны и сценарии удалены вместе с их тестами.
 */
import { PUBLIC_AGENCY_CONTACT } from "../lib/publicAgencyContact.js";
import { BW, EW, TAIL } from "./wordBoundary.js";
import { clientOwnWords } from "./untrustedContent.js";
import { withoutAgreementOpenings } from "./customerAgentHumanText.js";
import { foldCustomerText } from "./customerAgentRole.js";

/** Кто клиент — перечень ответа модели (ai/leadOnlyIntent.ts). Здесь, а не там: тип нужен сценарию, а круга импортов быть не должно. */
export const LEAD_ONLY_ROLES = ["buyer", "seller", "renter", "landlord", "job", "other"] as const;
export type LeadOnlyRole = typeof LEAD_ONLY_ROLES[number];
export interface LeadOnlyIntent {
  role: LeadOnlyRole;
  /** Клиент готов действовать сейчас: хочет приехать / посмотреть, спрашивает, куда ехать. */
  hot: boolean;
  /** Слова клиента, на которых стоит роль (у модели — проверенная цитата; у запасного пути — null). */
  quote: string | null;
  /** Слова ЭТОГО сообщения, на которых стоит горячесть. */
  hotQuote: string | null;
  source: "model" | "fallback";
  /** Почему запасной путь (для журнала): нет ответа модели, не прошла проверка, не о чем спрашивать. */
  fallbackReason?: "no_letters" | "model_unavailable" | "invalid_answer" | "quote_not_found";
}

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
  /** «Бот отвечает и после заявки» (владелец 20.11.2026, реестр выключателей). Старые вызовы без поля — ВКЛ. */
  repliesAfterLead?: boolean;
  /** После заявки: сотрудник писал в переписке за последние N минут — бот молчит (владелец 20.11.2026). */
  staffQuietMinutes?: number;
  /** «Бот пишет своими словами» (SPEC, этап 1.4): ВЫКЛ по умолчанию. */
  ownWords?: boolean;
}

export const LEAD_ONLY_DEFAULTS: LeadOnlyConfig = Object.freeze({
  enabled: false, useWhatsappNumber: true, maxPhoneAsks: 2, hotIntentHandover: true,
  workHoursStart: "09:30", workHoursEnd: "18:00", repliesAfterLead: true, staffQuietMinutes: 30, ownWords: false,
});

/**
 * Режим действует ТОЛЬКО в WhatsApp, Instagram и Facebook (решение 13.11.2026 после ревью):
 * чат сайта остаётся прежним (поиск, ссылки, фото), Telegram и комментарии тоже.
 * One config point (17.11.2026): env BOT_LEAD_ONLY_CHANNELS, a comma list of known names; empty, unset or only
 * unknown names = the default. Every mode check (both bot routes, the channel core, notifications) asks leadOnlyAppliesTo.
 */
export const LEAD_ONLY_DEFAULT_CHANNELS: readonly string[] = Object.freeze(["WHATSAPP", "INSTAGRAM", "FACEBOOK"]);
/** Names the setting accepts. WEBSITE and TELEGRAM are accepted so that extending the mode is one setting. */
export const LEAD_ONLY_KNOWN_CHANNELS: readonly string[] = Object.freeze([...LEAD_ONLY_DEFAULT_CHANNELS, "WEBSITE", "TELEGRAM"]);
const leadOnlyChannelsLogged = new Set<string>();
const leadOnlyChannelsParsed = new Map<string, readonly string[]>();
/** The channels of the mode from BOT_LEAD_ONLY_CHANNELS. Unknown names are ignored and logged once per value. */
export function leadOnlyChannels(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  const rawValue = env.BOT_LEAD_ONLY_CHANNELS ?? "";
  const cached = leadOnlyChannelsParsed.get(rawValue);
  if (cached) return cached;
  const raw = rawValue.split(",").map(name => name.trim().toUpperCase()).filter(Boolean);
  const known = [...new Set(raw.filter(name => LEAD_ONLY_KNOWN_CHANNELS.includes(name)))];
  const unknown = raw.filter(name => !LEAD_ONLY_KNOWN_CHANNELS.includes(name));
  if (unknown.length && !leadOnlyChannelsLogged.has(rawValue)) {
    leadOnlyChannelsLogged.add(rawValue);
    console.error(`[lead-only] BOT_LEAD_ONLY_CHANNELS=${JSON.stringify(rawValue)}: unknown channel name(s) ignored: ${unknown.join(", ")}` +
      (known.length ? "" : `; the default ${LEAD_ONLY_DEFAULT_CHANNELS.join(",")} applies`));
  }
  const result = Object.freeze(known.length ? known : [...LEAD_ONLY_DEFAULT_CHANNELS]);
  leadOnlyChannelsParsed.set(rawValue, result);
  return result;
}
export function leadOnlyAppliesTo(channel: string | null | undefined, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !!channel && leadOnlyChannels(env).includes(channel.trim().toUpperCase());
}

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
  // «Адрес» сам по себе — вопрос об объекте, а не готовность ехать (второе ревью 13.11): горячий только вместе
  // с намерением приехать, см. ADDRESS_WORD и COME_INTENT ниже.
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
  // «харидори воқеӣ / аслӣ», «мо харидорем»
  new RegExp(`${w(`харидор${TAIL}`)}\\s+${w(`во[қк]е${TAIL}|асл${TAIL}|ҳақиқ${TAIL}|хакик${TAIL}`)}`, "iu"),
];
const OFFICE_WORD = new RegExp(w(`офис${TAIL}|дафтар${TAIL}|идора${TAIL}|компани${TAIL}|агентств${TAIL}`), "iu");

// «Не готовы купить», «пока не хотим смотреть»: отрицание прямо перед горячими словами.
const NEGATION_BEFORE = new RegExp(`${BW}(?:не|нет|ни|пока\\s+не|ещ[её]\\s+не)\\s+(?:\\p{L}+\\s+)?$`, "iu");
// «Можно посмотреть фото/видео» — просьба о снимках, а не готовность ехать (снимков в этом режиме нет вовсе).
const MEDIA_AFTER = new RegExp(`^\\s+(?:(?:ещ[её]|е[её]|его|их|на)\\s+)?${w(`фот${TAIL}|видео${TAIL}|снимк${TAIL}|картинк${TAIL}|планировк${TAIL}|расв${TAIL}|сурат${TAIL}`)}`, "iu");
// «Можно посмотреть другие / ещё варианты?» — просьба о подборке, а не готовность ехать на объект (второе ревью 13.11).
const OTHER_OPTIONS_AFTER = new RegExp(`^\\s+(?:${w(`ещ[её]|какие-?(?:то|нибудь)`)}\\s+)?${w(`друг${TAIL}|ин(?:ые|ых|ой|ую)|вариант${TAIL}|подборк${TAIL}|что-?(?:то|нибудь)|ещ[её]|дигар${TAIL}`)}`, "iu");
// «Какой адрес?» — вопрос; «адрес? хотим завтра приехать» — горячо.
const ADDRESS_WORD = new RegExp(w(`адрес${TAIL}|суро[ғг]${TAIL}|локаци${TAIL}|геолокаци${TAIL}|лакатсия`), "iu");
const COME_INTENT = new RegExp(w(`приех${TAIL}|подъех${TAIL}|ехать|приезж${TAIL}|подъезж${TAIL}|прийти|прид[её]м|приду|зайти|зайд[её]м|` +
  `посмотреть|глянуть|сегодня|завтра|би[ёе]${TAIL}|омада${TAIL}|омадан|равем|равам|дидан|имр[ӯу]з|паго[ҳх]`), "iu");

function hotMatch(text: string, patterns: readonly RegExp[] = HOT_PATTERNS): boolean {
  for (const pattern of patterns) {
    const found = new RegExp(pattern.source, "giu");
    for (const match of text.matchAll(found)) {
      const start = match.index ?? 0, end = start + match[0].length;
      if (NEGATION_BEFORE.test(text.slice(Math.max(0, start - 24), start))) continue;
      if (MEDIA_AFTER.test(text.slice(end, end + 40)) || OTHER_OPTIONS_AFTER.test(text.slice(end, end + 40))) continue;
      return true;
    }
  }
  return false;
}

// «Сегодня не могу, напишу позже» — клиент откладывает (третье ревью 13.11, №5): горячим это не делает ни адрес,
// ни «сегодня» рядом. «Не могу найти, куда ехать» — наоборот, человек уже едет: такие продолжения не гасят.
// «Не могу говорить / разговаривать» — не отмена встречи, а просьба писать (четвёртое ревью 13.11, №3).
const POSTPONE = new RegExp([
  `${w("не")}\\s+${w("могу|можем|смогу|сможем|получится|успею|успеем|сейчас")}` +
    `(?!\\s+(?:${w("сейчас|щас|пока")}\\s+)?${w(`найти|найд${TAIL}|понять|дозвон${TAIL}|попасть|зайти|открыть|дождаться|` +
      `говорить|разговаривать|поговорить|ответить|отвечать|звонить|позвонить|слушать|взять`)})`,
  `${w("напишу|напишем|позвоню|позвоним|свяжусь|свяжемся|отвечу|ответим|сообщу|сообщим")}\\s+(?:\\p{L}+\\s+)?${w("позже|попозже|позднее|потом")}`,
  `${w("позже|попозже|позднее|потом")}\\s+(?:\\p{L}+\\s+)?${w("напишу|напишем|позвоню|позвоним|свяжусь|свяжемся|отвечу|ответим|сообщу|сообщим")}`,
  `${w("в")}\\s+${w("другой")}\\s+${w("раз")}`,
  w(`наметавон${TAIL}|наметонам|наметонем|намешавад|намерасам`),
  `${w("баъдтар|дертар|баъдан")}\\s+(?:\\p{L}+\\s+)?${w(`менавис${TAIL}|занг${TAIL}|хабар${TAIL}`)}`,
  `${w(`менавис${TAIL}`)}\\s+${w("баъдтар|дертар")}`,
].join("|"), "iu");
// Названа другая встреча — в ЛЮБОМ месте сообщения («сегодня не можем, завтра можно?», «Хочу посмотреть. Завтра можно?
// Сегодня не могу», четвёртое ревью 13.11, №3): клиент всё ещё хочет приехать.
const DAY_WORDS = `завтра|послезавтра|вечер${TAIL}|утр${TAIL}|понедельник${TAIL}|вторник${TAIL}|сред(?:а|у)|четверг${TAIL}|` +
  `пятниц${TAIL}|суббот${TAIL}|воскресень${TAIL}|выходн${TAIL}|пагоҳ|пагох|бегоҳ|бегох`;
const RESCHEDULE = new RegExp(w(DAY_WORDS), "iu");
// …кроме дня, от которого клиент отказался: «завтра не могу», «не могу завтра», «пагоҳ наметавонам».
const CANT = w("могу|можем|смогу|сможем|получится|успею|успеем");
const DAY_DECLINED = new RegExp(`${w(DAY_WORDS)}\\s+(?:${w("я|мы|тоже|уже")}\\s+)?${w("не")}\\s+${CANT}|` +
  `${w("не")}\\s+${CANT}\\s+${w(DAY_WORDS)}|${w(DAY_WORDS)}\\s+(?:\\p{L}+\\s+)?${w(`наметавон${TAIL}|наметонам|наметонем`)}`, "giu");
// «Ҳозир гап зада наметавонам» — не могу говорить, а не не могу приехать.
const TALK_BEFORE = new RegExp(`${w("гап")}\\s+(?:${w("зада|задан|задам")}\\s+)?$`, "iu");

function postponed(text: string): boolean {
  if (RESCHEDULE.test(text.replace(DAY_DECLINED, " "))) return false;
  const found = new RegExp(POSTPONE.source, "giu");
  for (const match of text.matchAll(found)) {
    if (TALK_BEFORE.test(text.slice(Math.max(0, (match.index ?? 0) - 20), match.index ?? 0))) continue;
    return true;
  }
  return false;
}

/** Клиент готов действовать: хочет посмотреть, «куда ехать», адрес вместе с намерением приехать. Отрицание,
 * «посмотреть фото» и «посмотреть другие варианты» — не горячие; голый «какой адрес?» — вопрос об объекте;
 * «не могу / напишу позже» без другой названной встречи — не горячие (третье ревью 13.11, №5). */
export function leadOnlyHotIntent(text: string): boolean {
  const raw = clientOwnWords(text), own = raw.replaceAll("ё", "е").replaceAll("Ё", "Е");
  if (!own.trim()) return false;
  const addressToCome = ADDRESS_WORD.test(own) && (hotMatch(own, [COME_INTENT]) || hotMatch(raw, [COME_INTENT]));
  if (!addressToCome && !hotMatch(own) && !hotMatch(raw)) return false;
  if (postponed(own)) return false;
  // «Адрес офиса» и «где ваш офис» — вопрос о компании, а не готовность ехать на объект.
  return !OFFICE_WORD.test(own);
}

// ── «Номер» — телефон или номер объекта ─────────────────────────────────────
// «Напишите номер объекта», «у меня нет номера квартиры», «рақами хона» — не телефон (третье ревью 13.11, №3, №4).
// Одно место для всех проверок режима, где «номер» значит телефон: отказ, фильтр просьбы в WhatsApp, счёт просьб.
const NOT_PHONE_NOUN = w(`объект${TAIL}|квартир${TAIL}|дом(?:а|е|у|ов)?|объявлени${TAIL}|карточк${TAIL}|участк${TAIL}|пост(?:а|е)?|` +
  `лот${TAIL}|заявк${TAIL}|этаж${TAIL}|подъезд${TAIL}|корпус${TAIL}|блок${TAIL}|кадастр${TAIL}|договор${TAIL}|паспорт${TAIL}|` +
  `машин${TAIL}|хона${TAIL}|эълон${TAIL}`);
// «Не дам номер СВОЕЙ квартиры», «номер этого объекта» (четвёртое ревью 13.11, №5): слово-указатель между ними не делает номер телефоном.
const OWNER_WORD = w(`сво(?:й|е|ё|ей|его|ему|ем|их)|мо(?:й|е|ё|ей|его|ем|их)|наш${TAIL}|ваш${TAIL}|эт(?:от|о|а|ой|ого|ом|их|у)|т(?:ой|ого|ом)|` +
  `нужн${TAIL}|нов${TAIL}|старо${TAIL}|ин|ҳамин|хамин|он`);
/** «номер/рақам», за которым не стоит «объекта/квартиры/дома…» (в том числе «своей квартиры»): тогда это телефон. */
const PHONE_NUMBER_WORD = `${w(`номер${TAIL}|рақам${TAIL}|ракам${TAIL}`)}(?!\\s+(?:${OWNER_WORD}\\s+)?${NOT_PHONE_NOUN})`;

// ── Удобное время звонка ────────────────────────────────────────────────────
// «Не звоните сейчас, позвоните завтра», «звоните после 6», «пагоҳ занг занед» — не отказ, а согласие со временем
// (третье ревью 13.11, №4): его записывают в заявку, чтобы агент не позвонил не вовремя.
const CALL_WORD = w(`(?:пере|по)?звон(?:ите|ить|и|ят)|набер(?:ите|и)|набрать|занг`);
const TIME_WORD = `(?:${w(`завтра|послезавтра|сегодня|сейчас|вечер${TAIL}|утр${TAIL}|дн[её]м|ночью|позже|попозже|позднее|потом|обед${TAIL}|` +
  `понедельник${TAIL}|вторник${TAIL}|сред(?:а|у)|четверг${TAIL}|пятниц${TAIL}|суббот${TAIL}|воскресень${TAIL}|выходн${TAIL}|` +
  `пагоҳ|пагох|бегоҳ|бегох|саҳар|сахар|ҳозир|хозир|имрӯз|имруз|баъдтар|дертар`)}|` +
  `${w("после|в|к|с|до|соати")}\\s*\\d{1,2}(?:[:.]\\d{2})?|\\d{1,2}(?:[:.]\\d{2})?\\s*${w(`час${TAIL}|соат${TAIL}`)})`;
const CALL_AT_TIME = new RegExp(`${CALL_WORD}(?:[\\s,]+\\p{L}+){0,3}[\\s,]+${TIME_WORD}|${TIME_WORD}(?:[\\s,]+\\p{L}+){0,3}[\\s,]+${CALL_WORD}`, "iu");
// Слово звонка под отрицанием — отказ, а не просьба (четвёртое ревью 13.11, №1): «Не звоните мне, я сейчас на работе»,
// «Звонить не надо, пишите потом», «Занг назанед, ҳозир кор дорам». Время звонка ищется только рядом с просьбой ПОЗВОНИТЬ.
const NEGATED_CALL = new RegExp([
  // «Не могли бы позвонить завтра?» — вежливая просьба, поэтому только «не (надо|нужно|стоит) звонить».
  `${w("не")}\\s+(?:${w("надо|нужно|стоит")}\\s+)?(?:${w("мне|нам|сюда")}\\s+)?${CALL_WORD}`,
  `${CALL_WORD}\\s+(?:${w("мне|нам|сюда")}\\s+)?${w("не")}\\s+${w("надо|нужно|стоит|обязательно")}`,
  `${w("занг")}\\s+${w(`назан${TAIL}`)}`,
  `${w(`занг${TAIL}`)}\\s+(?:${w("задан")}\\s+)?${w("лозим|даркор|шарт")}\\s+${w("нест|не")}`,
].join("|"), "giu");
/** Номер телефона в словах клиента (7+ цифр с пробелами, скобками, дефисами): «позвоните 93 555 12 34 завтра». */
const PHONE_DIGITS = /\+?\d[\d\s\-().]{5,}\d/gu;
function withoutPhoneDigits(text: string): string {
  // Цифры номера рвут поиск «позвоните … завтра» (№4 четвёртого ревью); номер в пометку времени не попадает.
  return text.replace(PHONE_DIGITS, found => (found.replace(/\D/gu, "").length >= 7 ? " " : found));
}
const ownForCall = (text: string) => withoutPhoneDigits(clientOwnWords(text)).replaceAll("ё", "е").replaceAll("Ё", "Е");

/**
 * Клиент говорит, КОГДА ему звонить: предложения с просьбой позвонить и временем, как он их написал (без цифр номера),
 * до 160 знаков. null — о времени звонка ничего. «Не звоните, я сейчас на работе» — не время, а отказ (четвёртое ревью, №1).
 */
export function leadOnlyCallbackTime(text: string): string | null {
  const sentences = ownForCall(text).split(/[.!?;\n]+/u).map(s => s.replace(/\s+/gu, " ").replace(/\s+,/gu, ",").trim())
    .filter(s => s && CALL_AT_TIME.test(s.replace(NEGATED_CALL, " × ")));
  return sentences.length ? sentences.join(". ").slice(0, 160) : null;
}

/** Пометка для агента в заявке: «…. Удобно звонить: «завтра после 6»». */
export function leadOnlyNoteWithCallbackTime(note: string, callbackTime: string | null | undefined): string {
  return callbackTime ? `${note}. Когда звонить: «${callbackTime}»` : note;
}

/** Пометка для агента: клиент отказался от звонка (четвёртое ревью 13.11, №1). */
export const LEAD_ONLY_NO_CALL_NOTE = "Просит не звонить, писать в чат";

// ── Отказ дать номер ────────────────────────────────────────────────────────
// «Не хочу давать номер», «номер не дам», «пишите здесь», «звонить не надо». Только после отказа
// бот говорит «хорошо, без проблем» и называет номер офиса; повторно номер не просит (второе ревью 13.11).
// «Номер» здесь — только телефон: «у меня нет номера объекта» не отказ (третье ревью 13.11, №4).
const PHONE_REF = `(?:${PHONE_NUMBER_WORD}|${w(`телефон${TAIL}`)})`;
const REFUSAL = new RegExp([
  `${w("не|нет")}\\s+(?:${w("хочу|хотим|буду|будем|могу|можем|дам|дадим|даю|оставлю|оставим")}\\s+)?` +
    `(?:${w("давать|дать|оставлять|оставить|писать|сообщать|сказать|говорить")}\\s+)?(?:${w("свой|свои|мой|наш")}\\s+)?${PHONE_REF}`,
  `${PHONE_REF}\\s+(?:${w("я|мы|свой|мой")}\\s+)?${w("не")}\\s+${w("дам|дадим|даю|оставлю|оставим|хочу|хотим|буду|скажу|напишу")}`,
  `${w("без")}\\s+(?:${PHONE_REF}|${w(`звонк${TAIL}`)})`,
  `${w("не")}\\s+(?:${w("надо|нужно")}\\s+)?${w("звоните|звонить|звони")}`,
  `${w(`звонить|звонков`)}\\s+${w("не")}\\s+${w("надо|нужно")}`,
  `${w("пишите|напишите|отвечайте|ответьте")}\\s+${w("здесь|тут|сюда")}`,
  `${PHONE_NUMBER_WORD}\\s+${w(`намедиҳ${TAIL}|намедих${TAIL}|намегузор${TAIL}|намегӯ${TAIL}`)}`,
  `${w("намехоҳам|намехохам|намедиҳам|намедихам")}\\s+${PHONE_NUMBER_WORD}`,
  `${w("занг")}\\s+${w("назанед|назанен")}`,
  `${w("ҳамин|хамин|инҷо|инчо")}\\s+(?:${w("ҷо|чо")}\\s+)?${w("нависед|нависен")}`,
].join("|"), "iu");

/** Клиент отказался дать номер или от звонка (а не просто промолчал о нём). */
export function leadOnlyPhoneRefused(text: string): boolean {
  const own = clientOwnWords(text).replaceAll("ё", "е").replaceAll("Ё", "Е");
  // «Не звоните сейчас, позвоните завтра» — согласие со временем, а не отказ (третье ревью 13.11, №4). Время засчитывается
  // только рядом с просьбой ПОЗВОНИТЬ: «Не звоните, я сейчас на работе» — отказ (четвёртое ревью 13.11, №1).
  return !!own.trim() && REFUSAL.test(own) && !leadOnlyCallbackTime(own);
}

// Вопрос о цене услуг агентства («сколько стоят ваши услуги», «комиссия какая», «хизмати шумо чанд пул»), текст в
// сложенном алфавите (foldCustomerText: ҳ→х, ӣ→и …).
const FEE_SUBJECT = /(?:^|[^\p{L}])(?:услуг\p{L}*|комисси\p{L}*|хизмат\p{L}*)/u;
const FEE_PRICE = /(?:^|[^\p{L}])(?:сколько|скока|цена|цену|стои\p{L}*|почем|процент\p{L}*|чанд|нарх\p{L}*|пул|арзиш\p{L}*|фоиз\p{L}*|ки?мм?ат\p{L}*)(?![\p{L}])/u;
// Сообщение о своём жилье — уже не «просто цена услуг»: «Квартира 3 комн., цена 70 000$, нужны ваши услуги» (ревью 18.11).
const FEE_HOUSING = /(?:^|[^\p{L}])(?:квартир\p{L}*|дом|дома|домик\p{L}*|хона\p{L}*|хавли\p{L}*|участ\p{L}*|замин\p{L}*|объект\p{L}*|комнат\p{L}*|хучр\p{L}*|продаж\p{L}*)(?![\p{L}])/u;
/**
 * Чистая: клиент спрашивает ТОЛЬКО цену услуг агентства, ни слова о своём жилье и без цифр. Сложенный алфавит
 * (foldCustomerText: ҳ→х, ӣ→и …).
 */
export function leadOnlyAgencyFeeQuestion(text: string): boolean {
  const folded = foldCustomerText(clientOwnWords(text ?? ""));
  return FEE_SUBJECT.test(folded) && FEE_PRICE.test(folded) && !/\d/u.test(folded) && !FEE_HOUSING.test(folded);
}

// ── Время звонка и короткие строки, которые остались у режима ───────────────

/** Когда агент позвонит — честно: в рабочее время «скоро», вне его — со времени начала. */
/** Сколько минут до конца рабочего дня бот уже не обещает «в ближайшее время». */
export const LEAD_ONLY_LATE_MINUTES = 60;
const minutesOf = (hhmm: string): number => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

export function leadOnlyCallbackWhen(input: { now: string; workHoursStart: string; workHoursEnd: string }):
  { kind: "soon" } | { kind: "today_from" | "tomorrow_from"; from: string } {
  const { now, workHoursStart: start, workHoursEnd: end } = input;
  const inside = start <= end ? now >= start && now < end : now >= start || now < end;
  // Последний час рабочего дня — уже не «в ближайшее время» (разбор 20.11.2026: вечерние заявки ждут агента 4,5–18 часов):
  // честно «завтра с <начало>», раньше позвонят — тем лучше.
  if (inside && start <= end && minutesOf(end) - minutesOf(now) <= LEAD_ONLY_LATE_MINUTES) return { kind: "tomorrow_from", from: start };
  if (inside) return { kind: "soon" };
  // До начала окна (раннее утро) — «сегодня с 09:30», после конца — «завтра утром».
  return start <= end && now < start ? { kind: "today_from", from: start } : { kind: "tomorrow_from", from: start };
}

/** The office telephone for customers (owner 18.11.2026: «+992446501414 это наш колл центр»). */
export const LEAD_ONLY_OFFICE_PHONE_TEXT = PUBLIC_AGENCY_CONTACT.phone;

/** Запасная строка свободного пути вне режима (вакансия, вырезанная фильтром подборка): с карточкой — «передал», без — офис. */
const ESCALATE_VARIANTS = {
  call: { ru: ["Передаю ваш вопрос агенту, он свяжется с вами.", "Передал ваш вопрос агенту, он свяжется с вами.", "Вопрос уже у агента, он свяжется с вами."],
    tg: ["Саволатонро ба агент мерасонам, ӯ бо шумо тамос мегирад.", "Саволатонро ба агент расондам, ӯ бо шумо тамос мегирад.", "Савол аллакай дар назди агент аст, ӯ бо шумо тамос мегирад."] },
  office: { ru: [`С этим вопросом поможет агент. Позвоните нам, пожалуйста: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Подробнее подскажет агент по телефону ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Этот вопрос лучше обсудить с агентом, наш номер: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`],
  tg: [`Дар ин савол агент ба шумо кӯмак мекунад, рақами мо: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Агент бо телефони ${LEAD_ONLY_OFFICE_PHONE_TEXT} бо тафсилот мегӯяд.`,
    `Ин саволро беҳтар аст бо агент гап занед, рақами мо: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`] },
} as const;

/** Короткая благодарность: последняя дверь не оставляет ответ пустым. */
const SHORT_ACKS = {
  ru: ["Понял вас, спасибо.", "Спасибо за ваше сообщение.", "Спасибо, что написали!"],
  tg: ["Фаҳмидам, ташаккур.", "Ташаккур барои паёматон.", "Раҳмат, ки навиштед!"],
} as const;

function normalizeSent(text: string): string { return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase(); }

/** Запасная строка свободного пути (не режима): без дословного повтора уже отправленного. */
export function leadOnlyEscalateLine(language: LeadOnlyLanguage, informed: boolean, sentTexts: readonly string[] = []): string {
  const sent = new Set(sentTexts.map(normalizeSent));
  const variants = ESCALATE_VARIANTS[informed ? "call" : "office"][language];
  return variants.find(line => !sent.has(normalizeSent(line))) ?? variants[variants.length - 1];
}

/**
 * THE LAST DOOR of every lead-only reply (17.11.2026, one brain): «Хорошо, …» / «Хуб, …» / «Конечно» after «Скидку сделаете?»
 * read as «да». Both routes pass the operator's final text here (lib/customerLeadOnlyCore.ts, messengers/conversation.ts): a
 * consent opening is cut; a reply left empty becomes a neutral thanks. The operator phrases are clean (CI guard), this is the belt.
 */
export function leadOnlyOutgoing(text: string, language: LeadOnlyLanguage): string {
  const cleaned = withoutAgreementOpenings(text).text.trim();
  return cleaned || SHORT_ACKS[language][1];
}

// ── Действия ядра, которых в режиме нет ─────────────────────────────────────
/**
 * Записи ядра, которые зовут людей сами (пуш агенту, дежурному или собственнику): передача сотруднику, звонок,
 * вопрос собственнику, показ (пятое ревью 13.11, №1). В режиме их нет ни в наборе модели, ни в исполнении:
 * людей зовёт только заявка (номер), а «соедините с человеком» без номера — просьба номера или номер офиса.
 */
export const LEAD_ONLY_WITHHELD_CUSTOMER_WRITES: readonly string[] = Object.freeze(["request_handover", "request_callback", "ask_owner", "book_showing"]);
export function leadOnlyWithholdsCustomerWrite(name: string): boolean {
  return LEAD_ONLY_WITHHELD_CUSTOMER_WRITES.includes(name);
}

// ── WhatsApp: номер не спрашиваем (второй слой) ─────────────────────────────
// В WhatsApp с рубильником «номер WhatsApp» номер отправителя и есть номер для звонка (владелец 12–13.11):
// правило промпта запрещает модели просить номер, а этот фильтр вырезает просьбу, если она всё же прозвучала.
// «Номер объекта / квартиры» — не телефон: такую просьбу не вырезаем (третье ревью 13.11, №3).
const PHONE_WORD = new RegExp(`${PHONE_NUMBER_WORD}|${w(`телефон${TAIL}`)}`, "iu");
const ASK_VERB = new RegExp(w(`оставьте|оставите|напишите|пришлите|отправьте|скиньте|дайте|подскажите|укажите|продиктуйте|` +
  `поделитесь|нависед|гузоред|фиристед|диҳед|дихед|мегузоред|мефиристед|навиштед|гӯед|гуед`), "iu");
// Просьба номера объекта/квартиры («номер квартиры», «рақами хона») рядом с просьбой телефона в том же предложении:
// «Скиньте номер квартиры и ваш номер» — вырезается только просьба телефона (четвёртое ревью 13.11, №5).
const OBJECT_NUMBER = new RegExp(`${w(`номер${TAIL}|рақам${TAIL}|ракам${TAIL}`)}\\s+(?:${OWNER_WORD}\\s+)?${NOT_PHONE_NOUN}`, "iu");
const CLAUSE_SPLIT = new RegExp(`(,\\s*|\\s+(?:${w("и|а также|ва")})\\s+)`, "u");
const LEADING_ASK = new RegExp(`^\\s*(?:${w("пожалуйста|лутфан")}[,\\s]+)?(${ASK_VERB.source})`, "iu");

/** Предложение без просьбы телефона, если в нём есть и просьба номера объекта; null — вырезать предложение целиком. */
function keepObjectNumberAsk(sentence: string): string | null {
  if (!OBJECT_NUMBER.test(sentence)) return null;
  const end = /[.!?…]+$/u.exec(sentence)?.[0] ?? "", body = sentence.slice(0, sentence.length - end.length);
  const pieces = body.split(CLAUSE_SPLIT); // [фраза, разделитель, фраза, …]
  const verb = LEADING_ASK.exec(pieces[0] ?? "")?.[1] ?? "";
  const kept: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const clause = pieces[i] ?? "";
    if (PHONE_WORD.test(clause.replace(OBJECT_NUMBER, " "))) continue;
    kept.push(kept.length ? `${pieces[i - 1] ?? " "}${clause}` : clause);
  }
  if (!kept.length) return null;
  let out = kept.join("").trim();
  // Глагол просьбы стоял в вырезанной части («Скиньте ваш номер и номер квартиры»): возвращаем его к оставшемуся.
  if (verb && !ASK_VERB.test(out)) out = `${verb} ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}${end}`;
}

export function leadOnlyStripPhoneAsk(text: string): { text: string; changed: boolean } {
  let changed = false;
  const lines = text.split("\n").map(line => {
    const sentences = line.split(/(?<=[.!?])\s+/u);
    const kept = sentences.flatMap(sentence => {
      const ask = PHONE_WORD.test(sentence) && ASK_VERB.test(sentence) && !sentence.includes(LEAD_ONLY_OFFICE_PHONE_TEXT);
      if (!ask) return [sentence];
      changed = true;
      const rest = keepObjectNumberAsk(sentence);
      return rest ? [rest] : [];
    });
    return kept.join(" ");
  });
  return { text: changed ? lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text, changed };
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
 * `changed` — только когда вырезана строка; схлопнутые пустые строки изменением не считаются.
 */
export function leadOnlyFilterReply(text: string): { text: string; changed: boolean } {
  const lines = text.split("\n");
  const cardLines = lines.filter(line => CARD_LINE.test(line) && (PRICE_WORD.test(line) || LIST_MARK.test(line)));
  const isList = cardLines.length >= 2;
  const kept = lines.filter(line => !URL_LINE.test(line) && !(isList && CARD_LINE.test(line)));
  const changed = kept.length !== lines.length;
  return { text: changed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text, changed };
}
