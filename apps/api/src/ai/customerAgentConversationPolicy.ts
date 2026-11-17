/** Presentation intent only. Neither rule grants a tool, identity or send.
 * Public praise uses the same free social path as the legacy comment handler,
 * but a positive allowlist avoids thanking an angry/ambiguous reaction. */
import {detectCustomerCoreLanguage as detectClientLanguage, customerColloquialTajikLanguage} from './customerDmLanguage.js';
import {clientOwnWords} from './untrustedContent.js';
import {foldCustomerTextForRole} from './customerAgentRole.js';
import {PUBLIC_AGENCY_WHATSAPP, publicAgencyCallReply} from '../lib/publicAgencyContact.js';
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

/**
 * ПРЯМОЙ ВОПРОС О КОМПАНИИ — ОДНА ДВЕРЬ (18.11.2026, аудит переписок 17.11, класс 1 «не отвечает на прямой вопрос»).
 *
 * Живые случаи: «Ватсап?» → «Это точно подскажет наш агент»; «Хози занг занам, мешавад?» → «Мехоҳед корманд ба шумо занг
 * занад?»; «ракамхоятонро дихед, ман занг занам» → номер не дан; «Куда можно отправить резюме?» → список вакансий без «куда».
 * Ответ — из фактов компании (lib/publicAgencyContact.ts, решение владельца 18.11.2026), РАНЬШЕ любого своего вопроса, кодом,
 * а не моделью. Только слова клиента (clientOwnWords, без цитат). Звонки в WhatsApp не включены: о них бот не говорит никогда,
 * на «можно позвонить по ватсапу?» — номер офиса для звонка.
 */
export type CustomerAgencyDirectQuestion = 'whatsapp' | 'call' | 'resume';
const WHATSAPP_RAW = /(?:whats\s*app|вотсап\p{L}*|ватсап\p{L}*|ватсаб\p{L}*|вотсаб\p{L}*|вацап\p{L}*|воцап\p{L}*|vatsap\p{L}*|watsap\p{L}*)/iu;
// Folded alphabet (ҳ→х, ӣ→и, ҷ→ч, қ→к, ӯ→у): «доред», «ҳаст», «мешавад», «рақам».
const WA_ASKS = /(?<!\p{L})(?:доред|дорен|дорин|дорет|дори|хаст|хастед|хаст\p{L}*|есть|имеется|у\s+вас|работает|кор\s+мекунад|мумкин|мешавад|мешава|можно|номер\p{L}*|ракам\p{L}*|кадом|какой|чанд|ин|этот|это)(?!\p{L})/u;
const NOT_WANTED = /(?<!\p{L})(?:не\s+(?:надо|нужно|нужен|хочу|пишите)|лозим\s+нест|намехохам|нахостам)(?!\p{L})/u;
const COMPLAINT = /(?<!\p{L})(?:не\s+(?:работает|отвечает|берет|доступен|проходит)|кор\s+намекунад|чавоб\s+намедихад|хомуш)(?!\p{L})/u;
const CALL_WORD = /(?<!\p{L})(?:(?:по|за|до|пере)?звон\p{L}*|занг)(?!\p{L})/u;
// «Можно позвонить?», «куда звонить?», «номер офиса?», «телефон агентства?»; «Хози занг занам, мешавад?», «ман занг занам».
const CALL_ASKED = new RegExp([
  String.raw`(?:можно|могу|можем|как|куда|разрешите)\s+(?:ли\s+)?(?:вам\s+|к\s+вам\s+|с\s+вами\s+)?(?:по|до|за)звонить`,
  String.raw`(?:по|до)звонить\s+(?:вам\s+)?(?:можно|сейчас|в\s+офис)`,
  String.raw`(?:номер|телефон)\p{L}*\s+(?:вашего\s+|вашей\s+)?(?:офиса|агентства|компании|фирмы|для\s+звонк\p{L}*)`,
  String.raw`(?:ваш|ваши|ваш\p{L}+)\s+(?:номер|телефон)\p{L}*(?!\s+(?:объект|квартир|дом|участк|хона|заявк)\p{L}*)`,
  String.raw`(?:ракам|номер)\p{L}*\s+(?:офис|идора|дафтар|ширкат)\p{L}*`,
  String.raw`занг\s+(?:занам|занем|задан|зада\s+метавон\p{L}*)`,
  String.raw`(?:ракам|номер)(?:хо)?(?:ятон|атон|тон|хотон)\p{L}*`,
  String.raw`у\s+вас\s+(?:номер|телефон)\p{L}*(?!\s+(?:объект|квартир|дом|участк|хона|заявк)\p{L}*)`,
  String.raw`какой\s+(?:ваш\s+)?(?:номер\s+телефона|телефон)(?!\s+(?:объект|квартир|дом|участк|хона|заявк)\p{L}*)`,
].join('|'), 'u');
const PERMISSION = /(?<!\p{L})(?:можно|могу|можем|разрешите|мумкин|мешавад|мешава|метавонам|метавонем)(?!\p{L})/u;
const RESUME = /(?<!\p{L})(?:резюме|rezyume|резуме)(?!\p{L})/u;
const RESUME_WHERE = /(?<!\p{L})(?:куда|кому|где|как|ба\s+кучо|кучо|ба\s+ки|чи\s+тавр|чихел|отправ\p{L}*|присла\p{L}*|присыла\p{L}*|скин\p{L}*|фирист\p{L}*|равон\p{L}*)(?!\p{L})/u;
/** What the customer's own words ask about the company's channels, office phone or résumé address; null when nothing. */
export function customerAgencyDirectQuestion(input: string): CustomerAgencyDirectQuestion | null {
  const raw = customerOwnUnquotedText(input).normalize('NFKC');
  if (!raw.trim() || raw.length > 400) return null;
  const folded = foldCustomerTextForRole(raw).replace(/ё/gu, 'е');
  if (NOT_WANTED.test(folded)) return null;
  // «Ваш телефон не работает?», «Номертон кор намекунад»: a complaint about a number, not a request for it (customerRequestedAgencyContact).
  if (COMPLAINT.test(folded)) return null;
  // The customer gives their OWN number (digits) and asks us to call: a callback, not a question about our phone.
  if (/\d{6,}/u.test(raw.replace(/[\s()-]/gu, '')) && !CALL_ASKED.test(folded)) return null;
  const asks = /[?？]/u.test(raw) || WA_ASKS.test(folded);
  if (WHATSAPP_RAW.test(raw)) {
    if (CALL_WORD.test(folded)) return 'call';
    const bare = !raw.replace(WHATSAPP_RAW, ' ').replace(/[\p{P}\p{S}\s]+/gu, '').trim();
    return bare || asks ? 'whatsapp' : null;
  }
  if (RESUME.test(folded) && RESUME_WHERE.test(folded) && (asks || /(?<!\p{L})(?:куда|кучо|кому)(?!\p{L})/u.test(folded))) return 'resume';
  if (CALL_ASKED.test(folded) && !/(?<!\p{L})(?:мой|моя|мне|ман|манро)\s+(?:номер|ракам)/u.test(folded)) return 'call';
  return null;
}
/** The fact lines that answer a direct question (one door for the core renderer and the lead-only mode). */
export function customerAgencyDirectAnswer(kind: CustomerAgencyDirectQuestion, input: { language: 'ru' | 'tg'; whatsappChannel: boolean; text: string }): string {
  const tg = input.language === 'tg';
  if (kind === 'whatsapp') return input.whatsappChannel
    ? tg ? 'Бале, шумо ба мо дар WhatsApp менависед.' : 'Да, вы пишете нам в WhatsApp.'
    : tg ? `Бале, WhatsApp: ${PUBLIC_AGENCY_WHATSAPP.phone}.` : `Да, WhatsApp: ${PUBLIC_AGENCY_WHATSAPP.phone}.`;
  if (kind === 'resume') return tg ? 'Резюмеро ҳамин ҷо, дар ҳамин чат фиристед.' : 'Резюме можно прислать сюда, в этот чат.';
  const call = publicAgencyCallReply(input.language);
  if (!PERMISSION.test(foldCustomerTextForRole(customerOwnUnquotedText(input.text)))) return call;
  return tg ? `Бале, ${call.charAt(0).toLowerCase()}${call.slice(1)}` : `Да, ${call.charAt(0).toLowerCase()}${call.slice(1)}`;
}
/** Every line customerAgencyDirectAnswer can produce: the read-only memory allow-list and the CI wording guard. */
export function customerAgencyDirectAnswerLines(): string[] {
  return (['ru', 'tg'] as const).flatMap(language => [true, false].flatMap(whatsappChannel => [
    customerAgencyDirectAnswer('whatsapp', { language, whatsappChannel, text: '' }),
    customerAgencyDirectAnswer('resume', { language, whatsappChannel, text: '' }),
    customerAgencyDirectAnswer('call', { language, whatsappChannel, text: '' }),
    customerAgencyDirectAnswer('call', { language, whatsappChannel, text: 'разрешите позвонить' }),
  ])).filter((line, index, all) => all.indexOf(line) === index);
}
