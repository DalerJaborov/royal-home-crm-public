/** Presentation intent only. Neither rule grants a tool, identity or send.
 * Public praise uses the same free social path as the legacy comment handler,
 * but a positive allowlist avoids thanking an angry/ambiguous reaction. */
import {detectClientLanguage} from './clientLanguage.js';
import {customerColloquialTajikLanguage} from './customerDmLanguage.js';
import {clientOwnWords} from './untrustedContent.js';
import {foldCustomerText} from './customerAgentRole.js';
import {BW, EW} from './wordBoundary.js';
const positiveEmoji = /(?:👍|👏|🙌|🤝|💪|🔥|✨|🌟|⭐|❤|🧡|💛|💚|💙|💜|🤍|🩷|💕|💖|💗|💓|💞|😍|🥰|🤩|😊|💐|🌹)[\uFE0F\u{1F3FB}-\u{1F3FF}]*/gu;
const appreciation = /^(?:спасибо(?: большое| вам)?|большое спасибо|благодарю|благодарим|(?:очень )?красивая квартира|красиво|очень красиво|красота|класс|супер|круто|отлично|молодцы|рахмат|раҳмат|ташаккур|зур|зӯр|офарин|аҳсан|зебо(?: бдай)?|бисёр зебо|(?:бехтарин|беҳтарин)(?: (?:хона|макон)(?: бдай)?)?)$/u;

/** Complete standalone reactions only; mixed questions remain tool-driven. */
export function customerPublicReaction(input:string): 'price_objection'|'appearance_objection'|null {
  const text=input.normalize('NFKC').toLowerCase().replace(/@[\p{L}\p{N}_.-]+/gu,' ')
    .replace(/[!.,\s]+/gu,' ').trim();
  if(/^(?:дорого|слишком дорого|очень дорого|кимат|қимат|киматай|қиматай|бисёр қимат|нархаш баланд)$/u.test(text))return 'price_objection';
  if(/^(?:безеб|бе зеб|ика бардакай|не нравится(?: ремонт| квартира| дом)?|некрасиво|ужасный ремонт)$/u.test(text))return 'appearance_objection';
  return null;
}
export function customerPublicReactionText(kind:'price_objection'|'appearance_objection',language:'ru'|'tg'):string {
  return kind==='price_objection'
    ? language==='tg'?'Кадом буҷет ба шумо мувофиқ аст? Метавонем вариантҳои арзонтарро ҷустуҷӯ кунем.':'Какой бюджет вам подходит? Можем поискать варианты дешевле.'
    : language==='tg'?'Фаҳмидам, ҳар кас завқи худро дорад. Шумо чӣ гуна хона мехоҳед?':'Понимаю, у каждого свой вкус. Какой вариант вам больше подошёл бы?';
}
/** Public short reactions often omit Tajik letters. Do not change the voice
 * language policy or infer language from another person's mentioned handle. */
export function customerPublicLanguage(input:string):'ru'|'tg' {
  const text=input.replace(/@[\p{L}\p{N}_.-]+/gu,' ').trim();
  const detected=detectClientLanguage(text);
  if(detected==='tg')return 'tg';
  if(customerColloquialTajikLanguage(text))return 'tg';
  if(detected==='ru')return 'ru';
  const tajikReaction=customerPublicReaction(text)&&/безеб|бе зеб|ика бардакай|кимат/iu.test(text);
  const tajikPraise=isCustomerPublicAppreciation(text)&&/зебо|бехтарин|офарин|зур/iu.test(text);
  return tajikReaction||tajikPraise?'tg':'ru';
}

export function isCustomerPublicAppreciation(input: string): boolean {
  if (!input.trim() || input.length > 500) return false;
  let matchedEmoji = false;
  const words = input.normalize("NFKC").toLowerCase().replace(/@[\p{L}\p{N}_.-]+/gu, " ").replace(positiveEmoji, () => { matchedEmoji = true; return " "; })
    .replace(/[!.,\s]+/gu, " ").trim();
  return words ? appreciation.test(words) : matchedEmoji;
}

/** Only current, explicit requests for the AGENCY'S contact. A callback,
 * customer's own phone, property number or model phone-question is not one.
 * Keep unknown phrasing conservative: no unsolicited call-to-action. */
export function customerRequestedAgencyContact(input: string): boolean {
  const text = input.normalize("NFKC").toLowerCase().replace(/ё/gu, "е");
  const parts = text.split(/[.;\n]+/u);
  return parts.some(part => {
    const t = part.trim().replace(/[!?？]+$/u, "").trim();
    if (!t || /(?:не\s+(?:нужен|нужны|надо|присылайте|отправляйте|давайте|пишите)|рақам\S*\s+лозим\s+нест)/u.test(t)) return false;
    if (/(?:не\s+работает|не\s+отвечает|кор\s+намекунад)/u.test(t) && !/(?:другой|дайте|пришлите|навис)/u.test(t)) return false;
    if (/(?:мой|моя|мои|ман|кварти\S*|объект\S*|заказ\S*|этаж\S*)\s+(?:номер|телефон|рақам)|(?:номер|рақам)\s+(?:квартир|объект|заказ|ман)/u.test(t)) return false;
    if (/(?:как\s+(?:с\s+вами\s+)?связаться|как\s+(?:вам|к\s+вам)\s+(?:по|до)звонить|куда\s+(?:по|до)звонить|ч[иӣ]\s+тавр\s+(?:бо\s+шумо\s+тамос|ба\s+шумо\s+занг))/u.test(t)) return true;
    const contact = /(?:номер(?:тон\S*|атон\S*)?|телефон\S*|рақам\S*|ракам\S*|контакт\S*|whatsapp|вотсап\S*)/u;
    if (!contact.test(t)) return false;
    if (/[?？]/u.test(part) && /(?:ваш\S*\s+(?:номер|телефон|контакт|whatsapp|вотсап)|(?:номер|телефон|контакт)\S*\s+(?:агентства|компании|шумо))/u.test(t)) return true;
    // A bare contact question and common RU/TG requests, including colloquial
    // Cyrillic Tajik used by actual clients ("номер телефона чанд боша").
    return /^(?:ваш\S*\s+|шумо\s+)?(?:номер(?:тон\S*|атон\S*)?(?:\s+телефона)?|телефон|контакты|рақам(?:атон|тон)?|ракам(?:атон|тон)?|whatsapp|вотсап)[\s:]*$/u.test(t) ||
      /(?:можно|дайте|напишите|пришлите|скиньте|подскажите|какой|чан\S*|навис\S*|тиен|теен|диҳ\S*|бте\S*)/u.test(t) ||
      /(?:номер(?:тон|атон)|рақаматон|рақамтон|ракаматон|ракамтон)/u.test(t);
  });
}

export function customerPublicThanks(input: string, language: "ru" | "tg"): string {
  const variants = language === "tg"
    ? ["Ташаккур, хурсандем, ки маъқул шуд 🤍", "Раҳмат барои дастгирӣ ✨"]
    : ["Спасибо, рады, что понравилось 🤍", "Благодарим за поддержку ✨"];
  // Stable across rendering/sealing/retries, no random copy or hidden state.
  let index = 0;
  for (const point of input) index = (index + point.codePointAt(0)!) % variants.length;
  return variants[index];
}

/** Keep code-driven subintent detection on the customer's own, unquoted words.
 * Document/video/CRM text is already removed by clientOwnWords; paired quotes
 * are removed too so copied prompts cannot trigger a deterministic response. */
export function customerOwnUnquotedText(input: string): string {
  return clientOwnWords(input).replace(/"[^"\r\n]*"|«[^»\r\n]*»|“[^”\r\n]*”|„[^”\r\n]*”|‘[^’\r\n]*’/gu, " ");
}
function ownIntentClauses(input: string): string[] {
  return customerOwnUnquotedText(input).split(/(?<=[?？!.,;\n])\s+|\s+(?:и|а|но|ҳам|ва)\s+/iu)
    .map(part => part.trim()).filter(Boolean);
}
function normalizeOwnIntent(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/ё/gu, "е").replace(/[!?？.,;:]+/gu, " ").replace(/\s+/gu, " ").trim();
}
const languagePermissionClause = /^(?:(?:а\s+)?можно\s+(?:мне\s+)?(?:рассказать|написать|говорить)\s+(?:о\s+себе|про\s+себя)\s+(?:на\s+таджикск\p{L}*|по[-\s]таджикск\p{L}*)|(?:на\s+таджикск\p{L}*|по[-\s]таджикск\p{L}*)\s+(?:можно\s+)?(?:рассказать|написать)\s+(?:о\s+себе|про\s+себя)|(?:метавонам|мумкин\s+аст)\s+(?:(?:бо\s+забони\s+)?тоҷикӣ\s+)?(?:дар\s+бораи\s+худ|худам)\s+(?:ба\s+тоҷикӣ\s+)?(?:нақл\s+кунам|нависам))$/u;

/** Exact standalone intent remains useful to suppress only an unrelated
 * vacancy question. The plural detector can coexist with another subintent. */
export function customerRecruitmentLanguagePermissionQuestion(input: string): boolean {
  return languagePermissionClause.test(normalizeOwnIntent(customerOwnUnquotedText(input)));
}
export function customerRecruitmentLanguagePermissionRequested(input: string): boolean {
  return ownIntentClauses(input).some(part => languagePermissionClause.test(normalizeOwnIntent(part)));
}

/** A narrowly phrased request to follow/subscribe to the customer's page.
 * This grants no action and does not catch mixed questions. */
export function customerFollowRequest(input: string): boolean {
  const text = clientOwnWords(input).normalize("NFKC").toLowerCase().replace(/ё/gu, "е")
    .replace(/@[^\s]+/gu, " аккаунт ").replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\uFE0E\uFE0F\u200D]/gu, " ")
    .replace(/[!?？.,]+/gu, " ").replace(/\s+/gu, " ").trim();
  return /^(?:(?:пожалуйста\s+)?(?:подпишитесь|подпишись|follow|subscribe)\s+(?:на\s+)?(?:мой\s+)?(?:сайт\S*|страниц\S*|канал\S*|аккаунт\S*|инстаграм\S*)|(?:сайт\S*|страниц\S*|канал\S*|аккаунт\S*|инстаграм\S*)\s+(?:(?:нав\S*|нов\S*)\s+)?(?:мой\s+)?(?:подпишитесь|подпишись|под\s*кн\S*|follow|subscribe))$/u.test(text);
}

/** The property fact schema has no furniture-inclusion field. Match only a
 * standalone furnishing question; never infer price inclusion from photos. */
export function customerStandaloneFurnitureQuestion(input: string): boolean {
  const text = customerOwnUnquotedText(input).normalize("NFKC").toLowerCase().replace(/ё/gu, "е")
    .replace(/[!?？.,]+/gu, " ").replace(/\s+/gu, " ").trim();
  return /^(?:(?:а\s+)?(?:с\s+|бо\s+)?(?:мебель\S*|мебел\S*|вещ\S*|чизу\s*чора\S*)(?:\s+(?:есть|идет|входит|остается|прилагается|комплекте|цену))?|бо\s+чизу\s*чора\S*)$/u.test(text);
}

/** Recognize a furnishing question inside a mixed message without treating a
 * quoted/negated mention as a request. Unlike the standalone predicate, this
 * leaves any independently requested verified property facts renderable. */
export function customerFurnitureQuestionRequested(input: string): boolean {
  const furniture = /(?:мебел\p{L}*|вещ\p{L}*|чизу\s*чора\p{L}*)/iu;
  const explicitQuestion = /[?？]|(?<!\p{L})(?:есть|идет|входит|остается|прилагается|комплекте|дорад|мемонад|дохил|ба\s+нарх)(?!\p{L})/iu;
  const negativeIntent = /(?<!\p{L})(?:не\s+(?:спрашиваю|интересует|интересно|нужно|надо|хочу)|без\s+(?:мебели|мебел|вещей|чизу\s*чора))(?!\p{L})/iu;
  const hasQuestionElsewhere = /[?？]/u.test(customerOwnUnquotedText(input));
  // Preserve the legacy exact standalone forms, which are often sent without
  // punctuation (for example, “Бо чизу чораш”).
  if (customerStandaloneFurnitureQuestion(input)) return true;
  return ownIntentClauses(input).some(clause => {
    const normalized = normalizeOwnIntent(clause);
    const standaloneFurnishingClause = hasQuestionElsewhere && customerStandaloneFurnitureQuestion(clause);
    return furniture.test(normalized) && (/[?？]/u.test(clause) || explicitQuestion.test(normalized) || standaloneFurnishingClause) && !negativeIntent.test(normalized);
  });
}

/** A bounded request for a private chat channel. The reply only confirms that
 * this conversation can continue here; it never promises another integration. */
export function customerMessengerChannelQuestion(input: string): boolean {
  const channel = /(?:telegram|телеграм\p{L}*|whatsapp|ватсап\p{L}*|вотсап\p{L}*)/iu;
  const direction = /(?:через|(?<!\p{L})(?:в|по)(?!\p{L})|тавассути)\s+(?:telegram|телеграм\p{L}*|whatsapp|ватсап\p{L}*|вотсап\p{L}*)/iu;
  const request = /(?<!\p{L})(?:можно|можете|сможете|напиш\p{L}*|пиш\p{L}*|свяж\p{L}*|связаться|написать|позвонить|тамос|мумкин\s+аст|метавон\p{L}*|навиштан)(?!\p{L})/iu;
  const negativeIntent = /(?:^|\s)(?:не|нет|без)\s+\p{L}+/iu;
  return ownIntentClauses(input).some(clause => channel.test(clause) && direction.test(clause) && request.test(clause) && !negativeIntent.test(normalizeOwnIntent(clause)));
}

/** "I want to see it" without a stated time (01.11.2026 live: «хочу посмотреть» got the price again and a phone
 * question). Folded alphabet. Photo/video "посмотреть фото" is not a showing; a negation is not a wish; a stated
 * clock time goes to the booking path, which accepts only a full date. Grants no booking by itself. */
const SHOWING_WISH = new RegExp(`${BW}(?:посмотреть|глянуть|осмотреть|осмотр|просмотр|показ|приехать|дидан|медидем|медидам|медидан|омада бинам|тамошо(?: кунам| кунем| кардан)?|нишон дихед)${EW}`, "u");
const SHOWING_NOT = new RegExp(`${BW}(?:не (?:хочу|надо|нужно|буду|смогу|могу)|намехохам|лозим нест|даркор нест|фото\\p{L}*|видео\\p{L}*|акс\\p{L}*|расм\\p{L}*|снимк\\p{L}*|вариант\\p{L}*|други\\p{L}*|фикр\\p{L}*)${EW}`, "u");
export function customerShowingWish(input: string): boolean {
  const own = customerOwnUnquotedText(input), text = foldCustomerText(own);
  return SHOWING_WISH.test(text) && !SHOWING_NOT.test(text) && !/\d{1,2}[:.]\d{2}/u.test(own);
}
export const CUSTOMER_SHOWING_TIME_QUESTION = {
  ru: "Когда вам удобно посмотреть объект? Напишите день и время.",
  tg: "Кай барои дидани объект ба шумо қулай аст? Рӯз ва соатро нависед.",
} as const;
