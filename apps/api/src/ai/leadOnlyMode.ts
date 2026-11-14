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
 * Кто клиент (покупатель, продавец, аренда, работа) и готов ли он ехать, решает не этот файл, а одна дверь
 * ai/leadOnlyIntent.ts (модель с проверкой цитаты, регулярки ниже — только её запасной путь, 14.11.2026).
 *
 * Цифры в ответе — только из аргументов (данные базы), сам модуль их не придумывает.
 */
import { BW, EW, TAIL } from "./wordBoundary.js";
import { customerRecruitmentRequested } from "./customerAgentRecruitmentProtocol.js";
import { clientOwnWords } from "./untrustedContent.js";
import { looksLikeRentRequest } from "./rentGuard.js";

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
}

export const LEAD_ONLY_DEFAULTS: LeadOnlyConfig = Object.freeze({
  enabled: false, useWhatsappNumber: true, maxPhoneAsks: 2, hotIntentHandover: true,
  workHoursStart: "09:30", workHoursEnd: "18:00",
});

/**
 * Режим действует ТОЛЬКО в WhatsApp, Instagram и Facebook (решение 13.11.2026 после ревью):
 * чат сайта остаётся прежним (поиск, ссылки, фото), Telegram и комментарии тоже. Одно
 * место, которое все проверки режима спрашивают про канал.
 */
export const LEAD_ONLY_CHANNELS: readonly string[] = Object.freeze(["WHATSAPP", "INSTAGRAM", "FACEBOOK"]);
export function leadOnlyAppliesTo(channel: string | null | undefined): boolean {
  return !!channel && LEAD_ONLY_CHANNELS.includes(channel);
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
const POSITIVE_CALL = new RegExp(CALL_WORD, "iu");

/** Клиент ПРОСИТ позвонить (без отрицания): «позвоните мне», «занг занед». «Не звоните» сюда не попадает. */
export function leadOnlyCallRequested(text: string): boolean {
  return POSITIVE_CALL.test(ownForCall(text).replace(NEGATED_CALL, " × "));
}

/**
 * Клиент говорит, КОГДА ему звонить: предложения с просьбой позвонить и временем, как он их написал (без цифр номера),
 * до 160 знаков. null — о времени звонка ничего. «Не звоните, я сейчас на работе» — не время, а отказ (четвёртое ревью, №1).
 */
export function leadOnlyCallbackTime(text: string): string | null {
  const sentences = ownForCall(text).split(/[.!?;\n]+/u).map(s => s.replace(/\s+/gu, " ").replace(/\s+,/gu, ",").trim())
    .filter(s => s && CALL_AT_TIME.test(s.replace(NEGATED_CALL, " × ")));
  return sentences.length ? sentences.join(". ").slice(0, 160) : null;
}

/** Время звонка берётся из сообщений не старше суток: «позвоните завтра» трёхдневной давности уже не про завтра. */
export const LEAD_ONLY_CALLBACK_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Когда звонить — из этого сообщения, иначе из последнего сообщения клиента за сутки, где он это назвал.
 * `earlier` — прежние сообщения клиента по порядку; без отметки времени сообщение считается старым.
 */
export function leadOnlyRecentCallbackTime(current: string, earlier: ReadonlyArray<{ text: string; at?: string | null }>, now: Date): string | null {
  const since = now.getTime() - LEAD_ONLY_CALLBACK_WINDOW_MS;
  const fresh = earlier.filter(m => { const at = m.at ? Date.parse(m.at) : NaN; return Number.isFinite(at) && at >= since; });
  return [current, ...fresh.map(m => m.text).reverse()].map(text => leadOnlyCallbackTime(text)).find(Boolean) ?? null;
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

/**
 * Клиент не хочет звонка: отказ в этом сообщении, или раньше — если сейчас он сам не просит позвонить.
 * Без карточки номер больше не просим; с номером (WhatsApp, карточка) звонок не обещаем, агенту — пометка.
 */
export function leadOnlyCallDeclined(current: string, earlierUserTexts: readonly string[]): boolean {
  if (leadOnlyPhoneRefused(current)) return true;
  return !leadOnlyCallRequested(current) && earlierUserTexts.some(text => leadOnlyPhoneRefused(text));
}

// Клиент говорит именно про объект, который уже в разговоре: «интересует», «эта квартира», «хочу её посмотреть».
const PROPERTY_INTEREST = new RegExp([
  w(`интерес${TAIL}|нрав${TAIL}|понрав${TAIL}|посмотреть|подробн${TAIL}|актуальн${TAIL}`),
  `${w(`эт(?:а|у|от|ой|ого|ом|и|у)`)}\\s+${w(`квартир${TAIL}|дом${TAIL}|вариант${TAIL}|объект${TAIL}|участ${TAIL}|хон${TAIL}`)}`,
  `${w(`купить|взять|беру|бер[её]м|покупаю`)}\\s+${w(`е[её]|его`)}`,
  w(`маъ[қк]ул${TAIL}|писанд${TAIL}|дидан${TAIL}`),
  `${w(`ин|ҳамин|хамин`)}\\s+${w(`хона${TAIL}|квартира${TAIL}|объект${TAIL}|вариант${TAIL}`)}`,
].join("|"), "iu");

// ── Сценарий хода ───────────────────────────────────────────────────────────
export type LeadOnlyScenario = "hot" | "property" | "seller" | "buyer";

export interface LeadOnlyScenarioInput {
  /** Слова клиента в этом ходе (вместе с буфером). */
  text: string;
  /** Объект определён сервером (ссылка, пост, реклама, картинка) в этом или прошлых ходах. */
  propertyKnown: boolean;
  /** Объект определён именно в ЭТОМ сообщении (ссылка, пост, реклама, картинка этого хода). */
  propertyInMessage?: boolean;
  /** Клиент спрашивает о самом объекте (цена, адрес, площадь…): решает вызывающий по классификатору вопросов. */
  propertyAsked?: boolean;
  /** Разговор уже о работе (вакансии ведёт Ноза — не трогаем). */
  jobTopic?: boolean;
  config: Pick<LeadOnlyConfig, "hotIntentHandover">;
  /**
   * Роль и горячесть клиента — ТОЛЬКО из одной двери ai/leadOnlyIntent.ts (модель с проверкой цитаты, иначе запасные
   * регулярки). Обязательное поле: решить сценарий в обход двери нельзя (аудит 14.11.2026, «подскажите» → покупатель).
   */
  intent: LeadOnlyIntent;
}

/**
 * null — ход не про заявку (вопрос о компании, приветствие, вакансия, аренда):
 * его отвечает обычный путь бота, но тоже без подборок, фото и ссылок.
 */
export function leadOnlyScenario(input: LeadOnlyScenarioInput): LeadOnlyScenario | null {
  const own = clientOwnWords(input.text);
  if (!own.trim() || input.jobTopic) return null;
  // Запреты владельца решает код поверх любого ответа модели: вакансии ведёт рекрутер, аренды у агентства нет
  // (ai/rentGuard.ts, решение 21.08.2026) — отказ дело обычного пути.
  if (customerRecruitmentRequested(own) || looksLikeRentRequest(own)) return null;
  const { role, hot } = input.intent;
  if (role === "job" || role === "renter" || role === "landlord") return null;
  // Продавец — первым: «продаю, адрес такой-то» не горячий покупатель, а объект, оставшийся в фокусе
  // с прошлого разговора, не перебивает ясное «хочу продать свою квартиру».
  if (role === "seller") return "seller";
  if (input.config.hotIntentHandover && hot) return "hot";
  // Объект, оставшийся в фокусе с прошлых ходов, не делает «спасибо» или «где офис?» вопросом об объекте
  // (ревью 13.11: «Это объект №N, цена X.» на любое сообщение). Объект — только если он пришёл в этом
  // сообщении или клиент говорит именно о нём.
  if (input.propertyKnown && (input.propertyInMessage || input.propertyAsked || PROPERTY_INTEREST.test(own))) return "property";
  if (role === "buyer") return "buyer";
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
  /** Карточка клиента уже есть (номер в ней), а в этом ходе номера не было: «номер получил» сказать нельзя. */
  | { kind: "card" }
  /** Instagram/Facebook: номер ещё не дан; asksSoFar — сколько раз уже просили. */
  | { kind: "ask"; asksSoFar: number; maxAsks: number; officeAlreadyOffered: boolean;
      /** Клиент прямо отказался дать номер: больше не просим, «хорошо, без проблем» и номер офиса. */
      refused?: boolean };

export const LEAD_ONLY_OFFICE_PHONE_TEXT = "777 070 100";

/**
 * Тексты. Три случая там, где это важно для правды:
 *  - `call` — у агента есть номер (WhatsApp, клиент дал номер, карточка уже есть): можно обещать звонок;
 *  - `chat` — заявка или карточка есть, но звонить нельзя (клиент просил не звонить): «агент ответит здесь»;
 *  - `ask` — заявки нет (Instagram/Facebook без номера): человека никто не зовёт (решение владельца 13.11.2026:
 *    «никаких уведомлений, пока он не станет лидом»), поэтому ни «передаю агенту», ни «ответит здесь» —
 *    только честное «оставьте номер, агент позвонит» или номер офиса.
 * Ревью 13.11.2026: «агент подберёт и расскажет» без номера и без уведомления агента было обещанием, которого
 * никто не выполнит.
 */
const LINES = {
  hot: { ru: "Хорошо, передаю агенту.", tg: "Хуб, ба агент мерасонам." },
  hotProperty: { ru: (id: number) => `Хорошо, передаю агенту по объекту №${id}.`, tg: (id: number) => `Хуб, оид ба объекти №${id} ба агент мерасонам.` },
  hotChat: { ru: "Хорошо, передаю агенту, он ответит вам здесь.", tg: "Хуб, ба агент мерасонам, ӯ ҳамин ҷо ба шумо ҷавоб медиҳад." },
  hotPropertyChat: {
    ru: (id: number) => `Хорошо, передаю агенту по объекту №${id}, он ответит вам здесь.`,
    tg: (id: number) => `Хуб, оид ба объекти №${id} ба агент мерасонам, ӯ ҳамин ҷо ба шумо ҷавоб медиҳад.`,
  },
  /** Заявки нет (номера нет): «передаю агенту» было бы неправдой, никого не зовём, и показ без заявки не обещаем
   * (пятое ревью 13.11, №3): показ назначает агент, дальше — просьба номера или номер офиса. */
  hotAsk: { ru: "Показ назначает агент.", tg: "Вақти намоишро агент таъин мекунад." },
  hotPropertyAsk: {
    ru: (id: number) => `Показ объекта №${id} назначает агент.`,
    tg: (id: number) => `Вақти намоиши объекти №${id}-ро агент таъин мекунад.`,
  },
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
  propertySoldChat: { ru: (id: number) => `Объект №${id} уже продан.`, tg: (id: number) => `Объекти №${id} аллакай фурӯхта шуд.` },
  propertyUnknown: { ru: "Понял, о каком объекте речь.", tg: "Фаҳмидам, кадом объектро дар назар доред." },
  buyerDistrict: {
    ru: (d: string, m: string) => `Да, есть варианты в районе ${d} от ${m}. Агент подберёт и расскажет подробнее.`,
    tg: (d: string, m: string) => `Бале, дар ноҳияи ${d} вариантҳо ҳастанд, аз ${m}. Агенти мо интихоб карда, муфассал мегӯяд.`,
  },
  buyerDistrictChat: {
    ru: (d: string, m: string) => `Да, есть варианты в районе ${d} от ${m}.`,
    tg: (d: string, m: string) => `Бале, дар ноҳияи ${d} вариантҳо ҳастанд, аз ${m}.`,
  },
  buyerAny: {
    ru: (m: string) => `Да, есть варианты от ${m}. Агент подберёт и расскажет подробнее.`,
    tg: (m: string) => `Бале, вариантҳо ҳастанд, аз ${m}. Агенти мо интихоб карда, муфассал мегӯяд.`,
  },
  buyerAnyChat: { ru: (m: string) => `Да, есть варианты от ${m}.`, tg: (m: string) => `Бале, вариантҳо ҳастанд, аз ${m}.` },
  buyerNone: {
    ru: "Подберём под ваш запрос, агент расскажет подробнее.",
    tg: "Мувофиқи дархостатон интихоб мекунем, агенти мо муфассал мегӯяд.",
  },
  buyerNoneChat: { ru: "Понял вас.", tg: "Фаҳмидам." },
  escalate: { ru: "Передаю ваш вопрос агенту, он свяжется с вами.", tg: "Саволатонро ба агент мерасонам, ӯ бо шумо тамос мегирад." },
  escalateChat: { ru: "Передаю ваш вопрос агенту, он ответит вам здесь.", tg: "Саволатонро ба агент мерасонам, ӯ ҳамин ҷо ба шумо ҷавоб медиҳад." },
  /** Заявки нет: вопрос не «передаётся» никому, дальше — просьба номера или номер офиса. */
  escalateAsk: { ru: "С этим вопросом поможет агент.", tg: "Дар ин савол агент ба шумо кӯмак мекунад." },
  /** Заявка или карточка есть (агент узнал заявкой или обычным сообщением), а всё прочее уже звучало. */
  waitingCall: { ru: "Агент уже в курсе и свяжется с вами.", tg: "Агент аллакай огоҳ аст ва бо шумо тамос мегирад." },
} as const;

/**
 * Варианты одних и тех же коротких строк: щит исходящих (lib/outboundShield.ts) не выпускает одинаковый
 * текст в третий раз, а его отказ на транспорте значит молчание (второе ревью 13.11, №9).
 */
const GIVEN_VARIANTS = {
  ru: [(at: string) => at ? `Спасибо, номер получил. Агент позвонит ${at}.` : "Спасибо, номер получил. Агент скоро позвонит.",
    (at: string) => at ? `Записал номер, агент позвонит ${at}.` : "Записал номер, агент скоро позвонит.",
    (at: string) => at ? `Спасибо, передал номер агенту, он позвонит ${at}.` : "Спасибо, передал номер агенту, он скоро позвонит."],
  tg: [(at: string) => at ? `Ташаккур, рақамро гирифтам. Агент ${at} занг мезанад.` : "Ташаккур, рақамро гирифтам. Агент ба зудӣ занг мезанад.",
    (at: string) => at ? `Рақамро навиштам, агент ${at} занг мезанад.` : "Рақамро навиштам, агент ба зудӣ занг мезанад.",
    (at: string) => at ? `Ташаккур, рақамро ба агент додам, ӯ ${at} занг мезанад.` : "Ташаккур, рақамро ба агент додам, ӯ ба зудӣ занг мезанад."],
} as const;
const ESCALATE_VARIANTS = {
  call: { ru: [LINES.escalate.ru, "Передал ваш вопрос агенту, он свяжется с вами.", "Вопрос уже у агента, он свяжется с вами."],
    tg: [LINES.escalate.tg, "Саволатонро ба агент расондам, ӯ бо шумо тамос мегирад.", "Савол аллакай дар назди агент аст, ӯ бо шумо тамос мегирад."] },
  // Заявки нет, человека не зовём (решение владельца 13.11.2026): честно — номер офиса.
  office: { ru: [`С этим вопросом поможет агент. Позвоните нам, пожалуйста: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Подробнее подскажет агент по телефону ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Этот вопрос лучше обсудить с агентом, наш номер: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`],
  tg: [`Дар ин савол агент ба шумо кӯмак мекунад. Лутфан, ба мо занг занед: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Агент бо телефони ${LEAD_ONLY_OFFICE_PHONE_TEXT} муфассал мегӯяд.`,
    `Ин саволро беҳтар аст бо агент гап занед, рақами мо: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`] },
} as const;

/**
 * Горячие слова без номера, когда просьбы номера исчерпаны и офис уже называли (пятое ревью 13.11, №3): одно «Показ
 * назначает агент.» оставляло клиента без пути к показу. Номер офиса повторяется, показ не обещается.
 */
const HOT_OFFICE_VARIANTS = {
  ru: [`Договориться о показе можно по телефону ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`, `Чтобы назначить показ, позвоните нам: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Время показа подскажет агент по телефону ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`],
  tg: [`Барои намоиш ба мо занг занед: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`, `Вақти намоишро бо телефони ${LEAD_ONLY_OFFICE_PHONE_TEXT} муайян мекунем.`,
    `Агент бо телефони ${LEAD_ONLY_OFFICE_PHONE_TEXT} вақти намоишро мегӯяд.`],
} as const;

/**
 * Карточка есть, а агента у неё нет («Прочие обращения», ночная раздача ещё не прошла — пятое ревью 13.11, №2):
 * «передаю агенту», «скоро позвонит», «уже в курсе» — неправда. Честно: записали, свяжутся в рабочее время.
 * `when` — срок словами из lib/handoffPromise.ts (с выходными из Настроек).
 */
const NO_AGENT_VARIANTS = {
  ru: [(when: string) => `Записали, с вами свяжутся ${when}.`, (when: string) => `Ваш вопрос записан, с вами свяжутся ${when}.`],
  tg: [(when: string) => `Навиштем, ${when} бо шумо тамос мегиранд.`, (when: string) => `Саволатон сабт шуд, ${when} бо шумо тамос мегиранд.`],
} as const;

/** Клиент с карточкой назвал удобное время звонка (третье ревью 13.11, №4): агенту передано, без дословного повтора. */
const CALLBACK_NOTED_VARIANTS = {
  ru: ["Хорошо, передам агенту, он позвонит в удобное вам время.", "Хорошо, агент в курсе и позвонит, когда вам удобно."],
  tg: ["Хуб, ба агент мерасонам, ӯ дар вақти барои шумо қулай занг мезанад.", "Хуб, агент огоҳ аст ва вақте ки ба шумо қулай аст, занг мезанад."],
} as const;

/** Клиент с карточкой просит не звонить (четвёртое ревью 13.11, №1): звонок не обещаем, агенту — пометка «писать в чат». */
const NO_CALL_NOTED_VARIANTS = {
  ru: ["Хорошо, без проблем. Передам агенту, что вам удобнее переписка, он ответит вам здесь.", "Хорошо, агент в курсе и ответит вам здесь."],
  tg: ["Хуб, бемалол. Ба агент мегӯям, ки ба шумо навиштан қулайтар аст, ӯ ҳамин ҷо ҷавоб медиҳад.", "Хуб, агент огоҳ аст ва ҳамин ҷо ба шумо ҷавоб медиҳад."],
} as const;

/** Короткие ответы на случай, когда всё остальное уже звучало (щит не выпустит третий одинаковый текст). */
const SHORT_ACKS = {
  ru: ["Понял вас, спасибо.", "Хорошо, понял.", "Да, понял вас."],
  tg: ["Фаҳмидам, ташаккур.", "Хуб, фаҳмидам.", "Бале, фаҳмидам."],
} as const;

function whenText(when: ReturnType<typeof leadOnlyCallbackWhen>, language: LeadOnlyLanguage): string {
  if (when.kind === "soon") return "";
  if (language === "tg") return when.kind === "today_from" ? `имрӯз аз соати ${when.from}` : `пагоҳ саҳар аз соати ${when.from}`;
  return when.kind === "today_from" ? `сегодня с ${when.from}` : `завтра утром, с ${when.from}`;
}

const OFFICE_LEAD = { ru: "Хорошо, без проблем. ", tg: "Хуб, бемалол. " } as const;

/** Строка про звонок/номер. null — номер просить больше нельзя и офис уже предлагали: молчим про номер. */
export function leadOnlyPhoneLine(phone: LeadOnlyPhoneState, when: ReturnType<typeof leadOnlyCallbackWhen>,
  language: LeadOnlyLanguage): string | null {
  const at = whenText(when, language);
  if (phone.kind === "whatsapp") {
    if (language === "tg") return at ? `Агент ${at} ба ҳамин рақам ба шумо занг мезанад, мувофиқ аст?` : "Агент ба ҳамин рақам ба шумо занг мезанад, мувофиқ аст?";
    return at ? `Агент позвонит вам на этот номер ${at}. Удобно?` : "Агент позвонит вам на этот номер, удобно?";
  }
  if (phone.kind === "given") return GIVEN_VARIANTS[language][0](at);
  if (phone.kind === "card") {
    if (language === "tg") return at ? `Агент ${at} ба шумо занг мезанад.` : "Агент ба зудӣ ба шумо занг мезанад.";
    return at ? `Агент позвонит вам ${at}.` : "Агент скоро позвонит вам.";
  }
  if (!phone.refused && phone.asksSoFar < phone.maxAsks) {
    if (phone.asksSoFar === 0) {
      return language === "tg" ? "Рақами телефонатонро нависед, то агент занг занад." : "Оставьте, пожалуйста, номер телефона, агент перезвонит.";
    }
    return language === "tg" ? "Агар мувофиқ бошад, рақаматонро нависед, агент худаш занг мезанад."
      : "Если удобно, напишите номер, и агент позвонит сам.";
  }
  if (phone.officeAlreadyOffered) return null;
  // «Хорошо, без проблем» — только в ответ на отказ; клиенту, который просто не ответил на просьбу, это звучит странно.
  if (phone.refused) return language === "tg" ? `${OFFICE_LEAD.tg}Агар хоҳед, худатон ба мо занг занед: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`
    : `${OFFICE_LEAD.ru}Если захотите, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`;
  return language === "tg" ? `Агар хоҳед, ба мо худатон занг занед: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`
    : `Если удобнее, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`;
}

/** «Номер получил» без дословного повтора уже отправленного (старый путь отвечает этим на голый номер). */
export function leadOnlyGivenLineAvoidingRepeat(when: ReturnType<typeof leadOnlyCallbackWhen>, language: LeadOnlyLanguage,
  sentTexts: readonly string[]): string {
  const at = whenText(when, language), sent = new Set(sentTexts.map(normalizeSent));
  const variants = GIVEN_VARIANTS[language].map(line => line(at));
  return variants.find(line => !sent.has(normalizeSent(line))) ?? variants[variants.length - 1];
}

/** Все строки-просьбы номера (для подсчёта, сколько раз уже просили). */
export function leadOnlyPhoneAskLines(): string[] {
  return ["Оставьте, пожалуйста, номер телефона, агент перезвонит.", "Если удобно, напишите номер, и агент позвонит сам.",
    "Рақами телефонатонро нависед, то агент занг занад.", "Агар мувофиқ бошад, рақаматонро нависед, агент худаш занг мезанад."];
}

/**
 * Сколько раз бот уже просил номер и предлагал ли номер офиса — по своим прежним репликам.
 * Ядро обязано передавать сюда то, что РЕАЛЬНО ушло клиенту (lib/customerLeadOnlyCore.ts читает
 * отправленные части), а не память модели: в памяти ядра остаются только строки из белого списка,
 * и короткий ответ этого режима туда не попадал, отчего счётчик был всегда 0 (ревью 13.11.2026).
 */
export function leadOnlyPhoneAskHistory(assistantTexts: readonly string[]): { asksSoFar: number; officeAlreadyOffered: boolean } {
  const asks = leadOnlyPhoneAskLines();
  // Прежние просьбы номера обычным путём бота тоже считаются (шаблон ядра и вольные фразы старого пути).
  // «Напишите номер объекта» — не просьба телефона (третье ревью 13.11, №3): тот же признак, что у фильтра и отказа.
  const generic = new RegExp(`(?:номер${TAIL}\\s+телефон|${w("оставьте|напишите")}\\s+(?:${w("ваш|свой")}\\s+)?${PHONE_NUMBER_WORD}|` +
    `${PHONE_NUMBER_WORD}(?:\\s+\\S+){0,2}\\s+нависед|${PHONE_NUMBER_WORD}\\s+мегузоред)`, "iu");
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
  /**
   * Агент узнаёт о клиенте: заявка заводится (номер есть) или карточка уже есть (агенту приходит обычное
   * уведомление о сообщении). Без этого «передаю агенту» и «ответит здесь» — неправда: до заявки людей
   * не зовём (решение владельца 13.11.2026). По умолчанию — когда номер у агента есть.
   */
  agentInformed?: boolean;
}

/** Номера нет, агент не знает о клиенте, просить номер больше нельзя и офис уже называли: строки про номер нет. */
function leadOnlyOfficeRepeatNeeded(input: LeadOnlyReplyInput, phoneLine: string | null): boolean {
  return input.phone.kind === "ask" && !(input.agentInformed ?? false) && phoneLine === null;
}

/** Части ответа: фраза по сути и строка про звонок/номер (её может не быть). */
export function leadOnlyReplyParts(input: LeadOnlyReplyInput): { intro: string; phoneLine: string | null } {
  const lang = input.language, p = input.property;
  // Звонок обещать можно, только если у агента есть номер: WhatsApp, номер от клиента или карточка.
  const call = input.phone.kind !== "ask";
  const informed = input.agentInformed ?? call;
  // Вопрос к сотруднику при заявке или карточке — только «передаю»; без заявки — та же просьба номера, что везде.
  let phoneLine = input.scenario === "escalate" && informed ? null : leadOnlyPhoneLine(input.phone, input.when, lang);
  let intro: string;
  switch (input.scenario) {
    case "hot":
      intro = call ? (p ? LINES.hotProperty[lang](p.shortId) : LINES.hot[lang])
        : informed ? (p ? LINES.hotPropertyChat[lang](p.shortId) : LINES.hotChat[lang])
        : p ? LINES.hotPropertyAsk[lang](p.shortId) : LINES.hotAsk[lang];
      break;
    case "seller": intro = LINES.seller[lang](input.sellerCommissionPercent); break;
    case "property":
      intro = !p ? LINES.propertyUnknown[lang] : p.sold ? (call ? LINES.propertySold : LINES.propertySoldChat)[lang](p.shortId)
        : p.price ? LINES.propertyPrice[lang](p.shortId, money(p.price, p.currency, lang)) : LINES.propertyNoPrice[lang](p.shortId);
      break;
    case "buyer": {
      const m = input.market;
      intro = m && Number(m.minPrice) > 0
        ? m.districtName
          ? (call ? LINES.buyerDistrict : LINES.buyerDistrictChat)[lang](m.districtName, money(m.minPrice, m.currency, lang))
          : (call ? LINES.buyerAny : LINES.buyerAnyChat)[lang](money(m.minPrice, m.currency, lang))
        : call ? LINES.buyerNone[lang] : LINES.buyerNoneChat[lang];
      break;
    }
    default: intro = call ? LINES.escalate[lang] : informed ? LINES.escalateChat[lang] : LINES.escalateAsk[lang];
  }
  // Показ или вопрос к агенту без номера, просьбы исчерпаны и офис уже называли (пятое ревью 13.11, №3): одна фраза
  // «Показ назначает агент.» не даёт клиенту пути к агенту — номер офиса повторяется, показ не обещается.
  const agentNeeded = input.scenario === "hot" || input.scenario === "escalate";
  if (agentNeeded && leadOnlyOfficeRepeatNeeded(input, phoneLine)) {
    return { intro: (input.scenario === "hot" ? HOT_OFFICE_VARIANTS : ESCALATE_VARIANTS.office)[lang][0], phoneLine: null };
  }
  // «Хорошо, передаю агенту… Хорошо, без проблем…» — второе «хорошо» лишнее.
  if (phoneLine && /^(?:Хорошо|Хуб)/u.test(intro)) phoneLine = phoneLine.replace(OFFICE_LEAD[lang], "");
  // Отказ дать номер: «Хорошо, без проблем» — первым, а не после «Показ назначает агент.» (пятое ревью 13.11, №3).
  else if (phoneLine?.startsWith(OFFICE_LEAD[lang]) && agentNeeded) {
    intro = `${OFFICE_LEAD[lang]}${intro}`;
    phoneLine = phoneLine.slice(OFFICE_LEAD[lang].length);
  }
  return { intro: intro.replaceAll("—", ","), phoneLine: phoneLine?.replaceAll("—", ",") ?? null };
}

/** Готовый короткий ответ: одна фраза по сути и одна про звонок. Без ссылок, списков и придуманных цифр. */
export function leadOnlyReply(input: LeadOnlyReplyInput): string {
  const parts = leadOnlyReplyParts(input);
  return [parts.intro, parts.phoneLine].filter(Boolean).join(" ");
}

function normalizeSent(text: string): string { return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase(); }

/**
 * Тот же ответ, но без повтора уже сказанного в этом разговоре (второе ревью 13.11, №2: «Это объект №112,
 * цена 520 000 сомони» звучало четыре раза подряд). Фраза по сути (объект, условия продавцу, «есть варианты
 * от…») говорится ОДИН раз: если она уже есть в отправленном, остаётся только строка про номер или звонок.
 * Всё уже звучало — «агент уже в курсе и свяжется» (только когда у агента есть номер: заявка или карточка),
 * затем короткое «понял вас». Без заявки «агент уже в курсе» не говорим: людей до заявки не зовут (решение
 * владельца 13.11.2026). Щит исходящих (lib/outboundShield.ts) не выпускает одинаковый текст в третий раз,
 * а на транспорте его отказ означает молчание, поэтому пустым или дословно повторённым ответ не бывает.
 */
export function leadOnlyReplyAvoidingRepeat(input: LeadOnlyReplyInput, sentTexts: readonly string[]): string {
  const sentList = sentTexts.map(normalizeSent), sent = new Set(sentList);
  if ((input.scenario === "hot" || input.scenario === "escalate") &&
      leadOnlyOfficeRepeatNeeded(input, leadOnlyPhoneLine(input.phone, input.when, input.language))) {
    // Номер офиса — каждый раз, но другими словами: щит не выпустит третий одинаковый текст (пятое ревью 13.11, №3).
    // Сначала ещё не звучавшие варианты, затем звучавшие один раз — давно звучавший первым.
    const variants: readonly string[] = (input.scenario === "hot" ? HOT_OFFICE_VARIANTS : ESCALATE_VARIANTS.office)[input.language];
    const times = (line: string) => sentList.filter(text => text === normalizeSent(line)).length;
    const lastAt = (line: string) => sentList.lastIndexOf(normalizeSent(line));
    const fresh = variants.filter(line => times(line) === 0);
    const once = variants.filter(line => times(line) === 1).sort((a, b) => lastAt(a) - lastAt(b));
    return fresh[0] ?? once[0] ?? SHORT_ACKS[input.language].find(text => !sent.has(normalizeSent(text))) ??
      SHORT_ACKS[input.language][SHORT_ACKS[input.language].length - 1];
  }
  const parts = leadOnlyReplyParts(input);
  const introSaid = sentList.some(text => text.includes(normalizeSent(parts.intro)));
  const waiting = input.phone.kind !== "ask" && (input.agentInformed ?? true) ? [LINES.waitingCall[input.language]] : [];
  const candidates = [introSaid ? "" : [parts.intro, parts.phoneLine].filter(Boolean).join(" "), parts.phoneLine ?? "",
    introSaid ? "" : parts.intro, ...waiting, ...SHORT_ACKS[input.language]].filter(Boolean);
  return candidates.find(text => !sent.has(normalizeSent(text))) ?? SHORT_ACKS[input.language][SHORT_ACKS[input.language].length - 1];
}

/**
 * Запасной короткий ответ вместо вырезанной фильтром подборки или ссылки (старый путь), когда сценарий режима
 * хода не нашёлся (вакансия). `informed` — у клиента есть карточка: агент видит переписку. Иначе никого не зовём
 * и не обещаем, а даём номер офиса. Без дословного повтора.
 */
export function leadOnlyEscalateLine(language: LeadOnlyLanguage, informed: boolean, sentTexts: readonly string[] = []): string {
  const sent = new Set(sentTexts.map(normalizeSent));
  const variants = ESCALATE_VARIANTS[informed ? "call" : "office"][language];
  return variants.find(line => !sent.has(normalizeSent(line))) ?? variants[variants.length - 1];
}

/** «Хорошо, передам агенту, он позвонит в удобное вам время» — без дословного повтора отправленного. */
export function leadOnlyCallbackNotedLine(language: LeadOnlyLanguage, sentTexts: readonly string[] = []): string {
  const sent = new Set(sentTexts.map(normalizeSent));
  const variants = [...CALLBACK_NOTED_VARIANTS[language], ...SHORT_ACKS[language]];
  return variants.find(line => !sent.has(normalizeSent(line))) ?? variants[variants.length - 1];
}

/** «Хорошо, агент ответит вам здесь» клиенту с карточкой, отказавшемуся от звонка, — без обещания звонка и без повтора. */
export function leadOnlyNoCallNotedLine(language: LeadOnlyLanguage, sentTexts: readonly string[] = []): string {
  const sent = new Set(sentTexts.map(normalizeSent));
  const variants = [...NO_CALL_NOTED_VARIANTS[language], ...SHORT_ACKS[language]];
  return variants.find(line => !sent.has(normalizeSent(line))) ?? variants[variants.length - 1];
}

/** Карточка без агента: «Записали, с вами свяжутся {срок}» — без обещаний агента и без дословного повтора. */
export function leadOnlyNoAgentLine(when: { ru: string; tg: string }, language: LeadOnlyLanguage, sentTexts: readonly string[] = []): string {
  const sent = new Set(sentTexts.map(normalizeSent));
  const variants = [...NO_AGENT_VARIANTS[language].map(line => line(when[language])), ...SHORT_ACKS[language]];
  return (variants.find(line => !sent.has(normalizeSent(line))) ?? variants[variants.length - 1]).replaceAll("—", ",");
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

// ── Память ядра: ответы этого режима — текст сервера ────────────────────────
// Ядро кладёт в память модели только строки, которые сервер мог сказать сам (lib/customerAgentVerifiedContext.ts).
// Ответы этого режима собираются из шаблонов ниже и туда не попадали: модель следующим ходом не знала, что бот уже
// просил номер или назвал объект, и отвечала невпопад («зачем номер?», второе ревью 13.11, №7). Здесь — проверка
// «строка целиком собрана из шаблонов режима»: подстановки только из базы (номер объекта, цена, район, время).
const SLOT = { id: 987654321, pct: 77, price: "\u0001", place: "\u0002", time: "\u0003", when: "\u0004" } as const;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function templateSource(text: string): string {
  return escapeRe(text).replaceAll(String(SLOT.id), "\\d{1,9}").replaceAll(`${SLOT.pct}%`, "\\d{1,2}(?:[.,]\\d{1,2})?%")
    .replaceAll(SLOT.price, "\\d[\\d\\u00a0 ]{0,14} (?:USD|сомони|сомонӣ)").replaceAll(SLOT.place, "[\\p{L}\\p{N} .'-]{1,60}")
    .replaceAll(SLOT.time, "\\d{1,2}:\\d{2}").replaceAll(SLOT.when, "[\\p{L}\\p{N} :.-]{1,40}");
}
let serverLinePattern: RegExp | null = null;
function leadOnlyServerLinePattern(): RegExp {
  if (serverLinePattern) return serverLinePattern;
  const texts = new Set<string>();
  const whens: Array<ReturnType<typeof leadOnlyCallbackWhen>> = [{ kind: "soon" }, { kind: "today_from", from: SLOT.time }, { kind: "tomorrow_from", from: SLOT.time }];
  for (const language of ["ru", "tg"] as const) {
    // Каждый шаблон явно; новый шаблон без строки здесь ловит тест «всё, что говорит режим, узнаётся памятью».
    const L = LINES;
    for (const line of [L.hot[language], L.hotProperty[language](SLOT.id), L.hotChat[language], L.hotPropertyChat[language](SLOT.id),
      L.hotAsk[language], L.hotPropertyAsk[language](SLOT.id), L.escalateAsk[language],
      L.seller[language](SLOT.pct), L.propertyPrice[language](SLOT.id, SLOT.price), L.propertyNoPrice[language](SLOT.id),
      L.propertySold[language](SLOT.id), L.propertySoldChat[language](SLOT.id), L.propertyUnknown[language],
      L.buyerDistrict[language](SLOT.place, SLOT.price), L.buyerDistrictChat[language](SLOT.place, SLOT.price),
      L.buyerAny[language](SLOT.price), L.buyerAnyChat[language](SLOT.price), L.buyerNone[language], L.buyerNoneChat[language],
      L.escalate[language], L.escalateChat[language], L.waitingCall[language]]) texts.add(line);
    for (const when of whens) {
      for (const phone of [{ kind: "whatsapp" }, { kind: "given" }, { kind: "card" }] as const) {
        const line = leadOnlyPhoneLine(phone, when, language); if (line) texts.add(line);
      }
      for (const variant of GIVEN_VARIANTS[language]) texts.add(variant(whenText(when, language)));
    }
    for (const refused of [false, true]) for (const asksSoFar of [0, 1, 3]) {
      const line = leadOnlyPhoneLine({ kind: "ask", asksSoFar, maxAsks: 2, officeAlreadyOffered: false, refused }, { kind: "soon" }, language);
      if (line) { texts.add(line); texts.add(line.replace(OFFICE_LEAD[language], "")); }
    }
    for (const line of [...SHORT_ACKS[language], ...ESCALATE_VARIANTS.call[language], ...ESCALATE_VARIANTS.office[language],
      ...CALLBACK_NOTED_VARIANTS[language], ...NO_CALL_NOTED_VARIANTS[language], ...HOT_OFFICE_VARIANTS[language],
      ...NO_AGENT_VARIANTS[language].map(line => line(SLOT.when)), OFFICE_LEAD[language].trim()]) texts.add(line);
  }
  const alternatives = [...texts].sort((a, b) => b.length - a.length).map(templateSource).join("|");
  serverLinePattern = new RegExp(`^(?:(?:${alternatives})(?: |$))+$`, "u");
  return serverLinePattern;
}
/** Строка целиком собрана из шаблонов этого режима (подстановки — номер объекта, цена, район, время из базы). */
export function leadOnlyServerLine(line: string): boolean {
  const text = line.trim();
  return text.length > 0 && text.length <= 600 && leadOnlyServerLinePattern().test(text);
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
