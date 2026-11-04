import { formatPropertyCode } from "@royal-home/shared";
import { groupPropertyReferenceNumbers, unaddressedReadRequest } from "./assistantGroupParticipation.js";
import { matchPublicShellRequest, readAssistantPublicSiteCatalog, replyPublicShellRequest, type PublicShellRequest } from "./assistantPublicShellSearch.js";

type Language = "ru" | "tg";
type GroupShellQuestion = { request: PublicShellRequest; siteOnly: boolean; guidance?: boolean; language?: Language };
const NUMBERED_QUESTIONS = /^1[.)]\s+(.{1,180}?)\s+2[.)]\s+(.{1,240})$/su;
const SALES_QUESTION = /ч[ӣи]\s+ҷавоб\s+диҳем|что\s+(?:нам\s+)?ответить/iu;
const SITE_QUESTION = /(?:^|[^\p{L}])сайт(?:и|е|а)?(?!\p{L})/iu;
const CRM_QUESTION = /(?<!\p{L})(?:(?:в|из|по)\s+(?:crm|црм)|дар\s+(?:crm|црм)|не\s+только\s+на\s+сайте)(?!\p{L})/iu;
const WRITE_REQUEST = /^(?:(?:пожалуйста|лутфан)[, ]+)?(?:добавь|создай|поменяй|измени|обнови|снизь|подними|удали|поставь|запиши|иваз кун|илова кун|сабт кун)(?!\p{L})/iu;
const CLARIFIERS = {
  tg: "Квартира меҷӯед ё ҳавлӣ?",
  ru: "Вы ищете квартиру или отдельный дом?",
} as const;

export function matchGroupPublicShellQuestion(text: string, addressed: boolean, ownBotQuestion?: string): GroupShellQuestion | null {
  const ordinary = (addressed || unaddressedReadRequest(text)) && !WRITE_REQUEST.test(text) ? matchPublicShellRequest(text) : null;
  if (ordinary) return { request: ordinary, siteOnly: SITE_QUESTION.test(text) && !CRM_QUESTION.test(text) };
  if (!addressed) return null;
  for (const lang of ["tg", "ru"] as const) {
    if (ownBotQuestion !== CLARIFIERS[lang] && !ownBotQuestion?.endsWith(`\n\n${CLARIFIERS[lang]}`)) continue;
    const answer = text.trim().replace(/[.!?]+$/u, "");
    if (/^(?:квартира|манзил)$/iu.test(answer)) return { request: { type: "APARTMENT" }, siteOnly: true, language: lang };
    if (/^(?:дом|отдельный дом|[ҳх]авл[иӣ])$/iu.test(answer)) return { request: { type: "HOUSE" }, siteOnly: true, language: lang };
  }
  // A sales colleague may ask two numbered questions: what to say, and what the site can filter.
  const parts = NUMBERED_QUESTIONS.exec(text);
  if (!parts || !SALES_QUESTION.test(parts[1]) || !SITE_QUESTION.test(parts[2])) return null;
  const request = matchPublicShellRequest(parts[1]);
  return request ? { request, siteOnly: true, guidance: true } : null;
}

export async function replyGroupPublicShellQuestion(question: GroupShellQuestion, lang: Language): Promise<string> {
  const language = question.language ?? lang;
  const result = await replyPublicShellRequest(question.request, language);
  if (!question.guidance) return result;
  const advice = language === "tg"
    ? "Ба харидор гӯед: «Фаҳмидам, хонаи тайёр бе таъмир меҷӯед». Аз сайт эълонҳои «коробка, бе таъмир»-ро ҷудо мекунам. Агар дар эълон навишта нашуда бошад, ки бино тайёр аст, аввал месанҷем."
    : "Скажите покупателю: «Поняла, ищете готовое жильё без ремонта». На сайте отберу объявления с пометками «коробка» и «без отделки». Если готовность дома не указана, сначала проверим её.";
  return `${advice}\n\n${result}`;
}

/** Guest answers use anonymous site data. CRM code and website listing ID are distinct. */
export async function replyPublicListingQuestion(ref: string, lang: "ru" | "tg"): Promise<string> {
  const [shortId] = groupPropertyReferenceNumbers(ref);
  const tajik = lang === "tg";
  const missing = tajik ? "Ин рақамро дар рӯйхати эълонҳои фаъоли сайт наёфтам. Рақамашро санҷед."
    : "Этого номера нет среди активных объявлений на сайте. Проверьте номер.";
  if (shortId === undefined) return missing;
  const catalog = await readAssistantPublicSiteCatalog();
  if (!catalog) return tajik
    ? "Ҳоло рӯйхати сайтро дида натавонистам. Каме баъд боз пурсед."
    : "Сейчас каталог сайта недоступен. Попробуйте чуть позже.";
  const matches = catalog.filter(row => row.crmShortId === shortId);
  if (matches.length !== 1) return missing;
  const [row] = matches;
  const code = formatPropertyCode(shortId);
  const price = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(row.price);
  return tajik ? `${code} дар сайт ҳаст · ${price} сомонӣ.` : `${code} есть на сайте · ${price} сомони.`;
}
