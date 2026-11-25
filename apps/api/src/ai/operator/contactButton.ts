/**
 * КНОПКА ЗВОНКА В WHATSAPP И ССЫЛКА ИЗ INSTAGRAM / FACEBOOK В WHATSAPP (владелец 25.11.2026, дословно: «Кнопка звонка делай в
 * вотцап. А в инстаграм если спрашивают то давай ссылку на наш вотцап каким нибудь специальным ссылкой чтобы бот понял что это
 * продолжение.»).
 *
 * Чистые функции, без базы: решение оператора (шаги, текст) не меняется — кнопка едет ПОД его ответом, а к тексту дописывается
 * одна строка «кнопка ниже». Решает код, а не модель:
 *  - просьба связаться («как с вами связаться», «дайте номер», «позвоните», «рақаматонро диҳед», «чӣ тавр тамос гирам») — код;
 *  - WhatsApp: кнопка `voice_call` на такую просьбу и в ходе, где принята заявка, — только при включённом рубильнике, в рабочие
 *    часы и когда сторож звонков недавно видел номер готовым (иначе клиент звонил бы в пустоту, а Meta прячет кнопку за низкую
 *    долю ответов);
 *  - Instagram / Facebook: на такую просьбу — кнопка-ссылка `https://wa.me/<наш номер>?text=<приветствие и код>`; только для
 *    своего бренда (аккаунту Арвана номер Royal Home не даём).
 * Код продолжения в WhatsApp — служебная метка: из слов клиента он вырезается всегда, в ответ и в заметку агенту не попадает.
 */
import { foldCustomerText } from "../customerAgentRole.js";
import { clientOwnWords } from "../untrustedContent.js";
import { BW, EW, TAIL } from "../wordBoundary.js";
import { OPERATOR_CONTACT_BUTTON_TEXTS } from "./phrases.js";
import type { OperatorChannel, OperatorLanguage } from "./types.js";

/** Сколько живёт кнопка звонка у клиента (минуты). Значок звонка в чате остаётся и после неё. ОЦЕНКА: полдня рабочего времени. */
export const WA_CALL_BUTTON_TTL_MINUTES = 240;
const WA_BODY_MAX = 1024;
const MESSENGER_TEXT_MAX = 640;

const WORDS = (n: number) => `(?:\\s+\\p{L}+){0,${n}}`;
/** Просьба связаться — по свёрнутому тексту (foldCustomerText: нижний регистр, ҳ→х, ӣ→и, ӯ→у, қ→к, ғ→г, ҷ→ч, без знаков). */
const CONTACT_ASK = new RegExp([
  // «как с вами связаться», «как вам позвонить», «как дозвониться»
  `${BW}как${EW}${WORDS(3)}\\s+(?:связат${TAIL}|свяж${TAIL}|позвонит${TAIL}|дозвонит${TAIL}|звонит${TAIL})`,
  // «куда вам звонить / писать»
  `${BW}куда${EW}${WORDS(2)}\\s+(?:позвонит${TAIL}|звонит${TAIL}|писат${TAIL}|написат${TAIL})`,
  // «можно вам позвонить», «хочу поговорить», «давайте созвонимся»
  `${BW}(?:можно|могу|хочу|хотел${TAIL}|давайте)${EW}${WORDS(2)}\\s+(?:позвонит${TAIL}|созвон${TAIL}|связат${TAIL}|поговорит${TAIL})`,
  // «дайте номер», «скиньте ваш телефон», «какой у вас номер»
  `${BW}(?:дайте|дай|скиньте|скинь|отправьте|пришлите|подскажите|оставьте)${EW}${WORDS(2)}\\s+(?:номер${TAIL}|телефон${TAIL}|контакт${TAIL})`,
  `${BW}какой\\s+у\\s+вас\\s+(?:номер${TAIL}|телефон${TAIL})`,
  // «ваш номер», «номер агента», «телефон офиса», «номер для связи»
  `${BW}(?:ваш${TAIL}|агентств${TAIL}|офис${TAIL}|компани${TAIL})\\s+(?:номер${TAIL}|телефон${TAIL}|контакт${TAIL})`,
  `${BW}(?:номер${TAIL}|телефон${TAIL})\\s+(?:для\\s+связи|агент${TAIL}|офис${TAIL}|ваш${TAIL}|компани${TAIL}|агентств${TAIL})`,
  `${BW}(?:контакты|созвонимся|созвониться)${EW}`,
  // «позвоните», «перезвоните» (клиент просит звонок)
  `${BW}(?:по|пере)звоните${EW}`,
  // «рақаматон», «рақами телефонатонро», «телефонатон»
  `${BW}ракам(?:и\\s+телефон)?(?:атон|етон|итон)${TAIL}`,
  `${BW}телефон(?:атон|етон|итон)${TAIL}`,
  // «рақами шумо», «рақами агент», «рақами офис»
  `${BW}ракам(?:и)?(?:\\s+телефон(?:и)?)?\\s+(?:шумо|агент${TAIL}|офис${TAIL}|компани${TAIL})${EW}`,
  // «чӣ тавр бо шумо тамос гирам», «чӣ хел занг занам»
  `${BW}(?:чи|чй)\\s+(?:тавр|хел|гуна)${EW}${WORDS(3)}\\s+(?:тамос${TAIL}|занг${TAIL})`,
  // «ба шумо занг занам», «занг задан мумкин», «куҷо занг занам», «тамос гирам»
  `${BW}ба\\s+(?:шумо|агент${TAIL})\\s+занг\\s+(?:занам|занем|задан)${EW}`,
  `${BW}занг\\s+(?:задан|занам|занем)\\s+(?:мумкин|мешавад|метавонам|метавонем)${EW}`,
  `${BW}кучо\\s+занг${TAIL}`,
  `${BW}тамос\\s+(?:гирам|гирем|гирифтан)${EW}`,
  // «занг занед» (клиент просит звонок); «занг назанед» сюда не попадает: другое слово
  `${BW}занг\\s+(?:занед|зананд|занетон)${EW}`,
].join("|"), "u");
/** Отказ от звонка — не просьба: «не звоните», «не надо звонить», «занг назанед», «тамос нагиред». */
const CONTACT_REFUSAL = new RegExp(`${BW}(?:не\\s+(?:надо\\s+)?(?:по|пере)?звон${TAIL}|занг\\s+назан${TAIL}|тамос\\s+нагир${TAIL})`, "u");
/** Клиент сам даёт свой номер («мой номер», «запишите», цифры номера) — это не просьба нашего. */
const OWN_NUMBER = new RegExp(`${BW}(?:мой|моя|мои|ракам(?:и)?\\s+ман|ракамам${TAIL}|запишите|сохраните)${EW}`, "u");

/** Клиент просит связаться: наш номер, как позвонить, «позвоните». Код, не модель. */
export function operatorContactAsk(text: string): boolean {
  const own = clientOwnWords(text);
  if ((own.match(/\d/gu)?.length ?? 0) >= 7) return false;
  const folded = foldCustomerText(own);
  if (!folded || CONTACT_REFUSAL.test(folded) || OWN_NUMBER.test(folded)) return false;
  return CONTACT_ASK.test(folded);
}

/** Код продолжения: «RH-» и шесть знаков алфавита без похожих символов (lib/whatsappContinuation.ts). */
export const CONTINUATION_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_BODY = `[${CONTINUATION_CODE_ALPHABET}${CONTINUATION_CODE_ALPHABET.toLowerCase()}]{6}`;
const CODE_IN_TEXT = new RegExp(`(?<![\\p{L}\\p{N}])#?\\s?(RH-${CODE_BODY})(?![\\p{L}\\p{N}])`, "iu");
const CODE_IN_TEXT_ALL = new RegExp(CODE_IN_TEXT.source, "giu");
/** Наше же предзаполненное начало («Продолжение из Instagram», «Идома аз Facebook») — вырезается вместе с кодом. */
const PREFILL_MARK = /(?:продолжение\s+из|идома\s+аз)\s+(?:instagram|facebook|инстаграм\p{L}*|фейсбук\p{L}*)/giu;

/** Код продолжения в словах клиента (заглавными), иначе null. */
export function findContinuationCode(text: string): string | null {
  const match = CODE_IN_TEXT.exec(clientOwnWords(text));
  return match ? match[1]!.toUpperCase() : null;
}

/** Слова клиента без кода и без нашего предзаполненного начала: код — служебная метка, не слова клиента. */
export function stripContinuationMarker(text: string): string {
  return text.replace(CODE_IN_TEXT_ALL, " ").replace(PREFILL_MARK, " ").replace(/[ \t]{2,}/gu, " ").replace(/\s+([.,!?])/gu, "$1").trim();
}

/** Предзаполненный текст ссылки wa.me (виден клиенту в поле ввода WhatsApp). */
export function continuationPrefill(language: OperatorLanguage, source: "INSTAGRAM" | "FACEBOOK", code: string): string {
  return OPERATOR_CONTACT_BUTTON_TEXTS.prefill[language]
    .replace("{source}", source === "FACEBOOK" ? "Facebook" : "Instagram").replace("{code}", `#${code}`);
}

export interface ContactButtonPolicy {
  /** Рубильник «Кнопка звонка в WhatsApp» (Настройки, botWaCallButton). */
  waCallButton: boolean;
  /** Сторож звонков недавно видел звонки и SIP включёнными, номер AVAILABLE. */
  waCallReady: boolean;
  /** Сейчас рабочие часы (Настройки): ночью звонок некому принять. */
  withinHours: boolean;
  /** Рубильник «Ссылка на WhatsApp в Instagram и Facebook» (botIgWhatsappLink). */
  igWhatsappLink: boolean;
  /** Номер WhatsApp агентства цифрами (Settings.metaWaDisplayPhone); null — ещё не известен. */
  waNumber: string | null;
}

export type OperatorContactButton =
  | { type: "voice_call"; displayText: string; ttlMinutes: number }
  | { type: "web_url"; title: string; url: string };

export interface OperatorContactButtonPlan {
  /** Ответ оператора с дописанной строкой «кнопка ниже». */
  text: string;
  button: OperatorContactButton;
}

/** Вариант строки: тот, что уже звучал в недавних ответах, — другой (без пластинки). */
function lineFor(variants: readonly string[], sent: readonly string[]): string {
  const used = variants.findIndex(line => sent.some(text => text.includes(line)));
  return variants[used === 0 ? 1 % variants.length : 0]!;
}

/**
 * Кнопка под ответом оператора этого хода или null (обычный текст). Нет ответа (тишина, бот уступил сотруднику), разговор
 * закрыт жалобой или грубостью — кнопки нет.
 */
export function planOperatorContactButton(input: {
  channel: OperatorChannel;
  language: OperatorLanguage;
  text: string | null;
  contactAsk: boolean;
  /** В этом ходе принята заявка (действие accept_lead). */
  leadAcceptedNow: boolean;
  closed: boolean;
  /** Клиент просил не звонить («пишите, не звоните»): кнопки звонка нет. */
  noCall?: boolean;
  /** Аккаунт своего бренда (не Арван): только ему ссылка на наш WhatsApp. */
  mainBrand: boolean;
  policy: ContactButtonPolicy;
  /** Код продолжения для ссылки из Instagram / Facebook (lib/whatsappContinuation.ts); null — ссылки нет. */
  code: string | null;
  /** Что бот уже отправил недавно (для выбора варианта строки). */
  sentBotTexts?: readonly string[];
}): OperatorContactButtonPlan | null {
  const text = input.text?.trim();
  if (!text || input.closed) return null;
  const sent = input.sentBotTexts ?? [];
  if (input.channel === "WHATSAPP") {
    const p = input.policy;
    if (!p.waCallButton || !p.waCallReady || !p.withinHours || input.noCall || !(input.contactAsk || input.leadAcceptedNow)) return null;
    const body = `${text} ${lineFor(OPERATOR_CONTACT_BUTTON_TEXTS.callLine[input.language], sent)}`;
    if ([...body].length > WA_BODY_MAX) return null;
    return { text: body, button: { type: "voice_call", displayText: OPERATOR_CONTACT_BUTTON_TEXTS.callTitle[input.language],
      ttlMinutes: WA_CALL_BUTTON_TTL_MINUTES } };
  }
  if (input.channel !== "INSTAGRAM" && input.channel !== "FACEBOOK") return null;
  const digits = input.policy.waNumber?.replace(/\D/gu, "") ?? "";
  if (!input.policy.igWhatsappLink || !input.mainBrand || !input.contactAsk || !input.code || !/^\d{9,15}$/u.test(digits)) return null;
  const body = `${text} ${lineFor(OPERATOR_CONTACT_BUTTON_TEXTS.linkLine[input.language], sent)}`;
  if ([...body].length > MESSENGER_TEXT_MAX) return null;
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(continuationPrefill(input.language, input.channel, input.code))}`;
  return { text: body, button: { type: "web_url", title: OPERATOR_CONTACT_BUTTON_TEXTS.linkTitle[input.language], url } };
}
