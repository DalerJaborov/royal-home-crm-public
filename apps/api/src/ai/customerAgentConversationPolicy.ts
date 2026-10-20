/** Presentation intent only. Neither rule grants a tool, identity or send.
 * Public praise uses the same free social path as the legacy comment handler,
 * but a positive allowlist avoids thanking an angry/ambiguous reaction. */
import {detectClientLanguage} from './clientLanguage.js';
const positiveEmoji = /(?:👍|👏|🙌|🤝|💪|🔥|✨|🌟|⭐|❤|🧡|💛|💚|💙|💜|🤍|🩷|💕|💖|💗|💓|💞|😍|🥰|🤩|😊|💐|🌹)[\uFE0F\u{1F3FB}-\u{1F3FF}]*/gu;
const appreciation = /^(?:спасибо(?: большое| вам)?|большое спасибо|благодарю|благодарим|(?:очень )?красивая квартира|красиво|очень красиво|красота|класс|супер|круто|отлично|молодцы|рахмат|раҳмат|ташаккур|зур|зӯр|офарин|аҳсан|зебо(?: бдай)?|бисёр зебо|(?:бехтарин|беҳтарин)(?: хона(?: бдай)?)?)$/u;

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
