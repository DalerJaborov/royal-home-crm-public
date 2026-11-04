import { formatPropertyCode } from "@royal-home/shared";
import { groupPropertyReferenceNumbers, unaddressedReadRequest } from "./assistantGroupParticipation.js";
import { matchPublicShellRequest, readAssistantPublicSiteCatalog, replyPublicShellRequest, type PublicShellRequest } from "./assistantPublicShellSearch.js";

type Language = "ru" | "tg";
type GroupShellQuestion =
  | { kind: "guidance" }
  | { kind: "search"; request: PublicShellRequest; siteOnly: boolean; language?: Language };
const NUMBERED_QUESTIONS = /^1[.)]\s+(.{1,180}?)\s+2[.)]\s+(.{1,240})$/su;
const SALES_QUESTION = /ч[ӣи]\s+ҷавоб\s+диҳем|что\s+(?:нам\s+)?ответить/iu;
const HOW_TO_ASK = /^(?:как\s+(?:спросить|сформулировать|попросить)|ч[ӣи]\s+(?:тавр|хел)\s+.{0,140}?(?:пурс|савол))/iu;
const CAPABILITY_QUESTION = /^(?:(?:оё\s+)?агар(?!\p{L}).*?(?:савол\s+диҳ|пурс).*?(?:метавон|мешавад)|если(?!\p{L}).*?(?:спросить|попросить).*?(?:смож|можно)|умеешь\s+ли(?!\p{L}))/iu;
const SITE_QUESTION = /(?:^|[^\p{L}])сайт(?:и|е|а)?(?!\p{L})/iu;
const CRM_QUESTION = /(?<!\p{L})(?:(?:в|из|по)\s+(?:crm|црм)|дар\s+(?:crm|црм)|не\s+только\s+на\s+сайте)(?!\p{L})/iu;
const WRITE_REQUEST = /^(?:(?:пожалуйста|лутфан)[, ]+)?(?:добавь|создай|поменяй|измени|обнови|снизь|подними|удали|поставь|запиши|иваз кун|илова кун|сабт кун)(?!\p{L})/iu;
const CLARIFIERS = {
  tg: "Квартира меҷӯед ё ҳавлӣ?",
  ru: "Вы ищете квартиру или отдельный дом?",
} as const;

export function matchGroupPublicShellQuestion(text: string, addressed: boolean, ownBotQuestion?: string): GroupShellQuestion | null {
  if (WRITE_REQUEST.test(text)) return null;
  if (addressed) {
    const parts = NUMBERED_QUESTIONS.exec(text);
    const questions = parts ? parts.slice(1) : [text];
    const guidance = questions.every(question => {
      if (!SALES_QUESTION.test(question) && !HOW_TO_ASK.test(question) && !CAPABILITY_QUESTION.test(question)) return false;
      // Tajik questions can add the direct-object suffix to the final condition.
      const topic = question.replace(/(бе\s*таъмир|бе\s*ремонт)ро(?!\p{L})/giu, "$1");
      return matchPublicShellRequest(topic) !== null;
    });
    if (guidance) return { kind: "guidance" };
  }

  const ordinary = (addressed || unaddressedReadRequest(text)) ? matchPublicShellRequest(text) : null;
  if (ordinary) return { kind: "search", request: ordinary, siteOnly: SITE_QUESTION.test(text) && !CRM_QUESTION.test(text) };
  if (!addressed) return null;
  for (const lang of ["tg", "ru"] as const) {
    if (ownBotQuestion !== CLARIFIERS[lang] && !ownBotQuestion?.endsWith(`\n\n${CLARIFIERS[lang]}`)) continue;
    const answer = text.trim().replace(/[.!?]+$/u, "");
    if (/^(?:квартира|манзил)$/iu.test(answer)) return { kind: "search", request: { type: "APARTMENT" }, siteOnly: true, language: lang };
    if (/^(?:дом|отдельный дом|[ҳх]авл[иӣ])$/iu.test(answer)) return { kind: "search", request: { type: "HOUSE" }, siteOnly: true, language: lang };
  }
  return null;
}

export async function replyGroupPublicShellQuestion(question: GroupShellQuestion, lang: Language): Promise<string> {
  if (question.kind === "search") return replyPublicShellRequest(question.request, question.language ?? lang);
  return lang === "tg"
    ? "Ба харидор гӯед: «Фаҳмидам, хонаи тайёр бе таъмир меҷӯед. Вариантҳоро месанҷам». Агар дар эълон навишта нашуда бошад, ки бино тайёр аст, аввал аниқ мекунем.\n\n" +
      "Барои ҷустуҷӯ нависед: «Шабнам, аз сайт квартираи коробка бе таъмир нишон деҳ». Кормандоне, ки Telegram-ашон ба CRM пайваст аст, метавонанд аз CRM ҳам ҷустуҷӯ кунанд. Он ҷо объектҳои барояшон дастрас ҳастанд, ҳатто агар ҳанӯз дар сайт набошанд."
    : "Скажите покупателю: «Поняла, ищете готовое жильё без ремонта. Посмотрю варианты». Если готовность дома в объявлении не указана, сначала её уточним.\n\n" +
      "Для поиска напишите: «Шабнам, покажи на сайте квартиры в коробке без ремонта». Сотрудники с привязанным Telegram могут искать и в CRM, включая доступные им объекты, которые ещё не вышли на сайт.";
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
