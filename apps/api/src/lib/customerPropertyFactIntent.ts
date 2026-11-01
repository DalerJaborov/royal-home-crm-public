import { customerPropertyFactKindSchema, type CustomerPropertyFactKind } from "@royal-home/shared";
import { customerPropertyUrl } from "./customerPropertyUrls.js";
import { PER_SQM_SOURCE } from "./customerPropertyPerSqm.js";
import { OBJECT_CODE_NUMBER_SOURCE, WEAK_PROPERTY_NUMBER_SOURCE, schemelessPropertyUrls, stripSchemelessPropertyUrls } from "./customerPropertyReferenceText.js";

const words = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "giu");
const PRICE = words("цен[ауеы]|стоимость|стоит|стоят|нархшчансумай|нарх(?:ашон|аша|аш|ша|ш|и)?|чандпул|чансумай|чандсумай|чанд\\s+(?:сомонӣ|сомони|сум)");
// "район" alone is a location question about the object already shown ("а район?"); a district inside a search wording stays with the search.
const ADDRESS = words("адрес(?:а|у|е|аш|ш|ша|и|ашро)?|суроға(?:аш|ш|и|ро)?|сурога(?:аш|ш|и|ро)?|расположен[аы]?|находится|находятся|где|куҷо(?:ст|ай)?|кучо(?:ст|ай)?|район(?:а|е|у|ом)?|микрорайон(?:е|а)?|ноҳия(?:и|аш|ро)?|ноҳияаш|ноҳияи");
const BUILDER = words("застройщик(?:а|у|е)?|строит|сохтмонч[ӣи]|ширкати\\s+сохтмон[ӣи]|к[ӣи]\\s+сохтааст");
const CHARACTERISTICS = words("площад[ьию]|этаж(?:е|а|ей|ность)?|комнат(?:а|ы|у)?|ремонт(?:ом|а)?|состояние|характеристик(?:и|а)|планировк(?:а|и)|масо[ҳх]ат(?:аш|и)?|ош[ёе]на(?:аш|и)?|таъмир(?:аш)?|[ҳх]у[ҷч]ра(?:г[ӣи]|аш)?");
const AVAILABILITY = words("ещ[её]\\s+есть|не\\s+продан(?:а|о|ы)?|доступ(?:ен|на|но|ны)|актуальн(?:а|о|ы)?|в\\s+наличии|[ҳх]оло\\s+(?:[ҳх]ам\\s+)?[ҳх]аст");
const DETAILS = words("подробнее|подробности|детали|маълумоти\\s+бештар|маълумот|муфассал");
const COURTESY = words("здравствуйте|здравствуй|привет|добрый\\s+(?:день|вечер)|доброе\\s+утро|салом(?:ат)?|ассалому\\s+алейкум|пожалуйста|лутфан|спасибо|рахмат|раҳмат");
// Only neutral framing is removable. Actions, negation, contact numbers, dates,
// budgets and unfamiliar words remain and send the turn to the existing path.
const FRAMING = words("а|и|или|но|да|ну|это|этот|эта|эту|этой|этом|этого|тот|та|ту|той|того|там|тут|в|во|на|по|о|об|у|для|мне|пожалуй|можно|ли|узнать|уточнить|скажите|подскажите|сообщите|расскажите|какая|какой|какие|какую|каком|кто|сколько|нужна|нужен|нужны|интересует|интересуют|квартир[аыуе]|дом(?:а|у|е)?|участ(?:ок|ка|ке)|объект(?:а|у|е|ом|ы|ов)?|ин|ҳамин|ҳамон|хона(?:и|ро)?|квартира(?:и|ро)?|объект(?:и|ро)?|дар|аз|ба|ва|ё|чанд|чӣ|чи|аст|ҳаст|мумкин|мешавад|метавонам|гирифта|донистан|гуед|гӯед|фаҳмам|кадом(?:е|аш)?");

/**
 * Deliberately narrow fast path, not a general intent classifier. Every word
 * must be a known fact question or neutral framing. Mixed requests stay with
 * the existing qualifier so this renderer cannot consume a requested action.
 * Evidence/permissions/offerability are resolved separately by server code.
 */
export function classifyCustomerPropertyFactIntent(text: string, options: { hasPropertyContext?: boolean } = {}): CustomerPropertyFactKind[] | null {
  if (!text || text.length > 600) return null;
  // The cost of renovation is not the property's asking price.
  if (/(?:стоит|стоимость|цена)\s+(?:на\s+)?ремонт|нархи\s+таъмир/iu.test(text)) return null;
  // NFKC turns № into the letters "No", losing the public-selector marker.
  let rest = text.replace(/№/g, "#").normalize("NFKC").toLowerCase();
  let unsupportedUrl = false;
  let explicitProperty = false;
  const readUrl = (raw: string) => {
    const parsed = customerPropertyUrl(raw.replace(/[),.;!?]+$/, ""));
    if (parsed.kind === "denied" || parsed.kind === "unsupported") unsupportedUrl = true;
    else if (parsed.kind === "site") explicitProperty = true;
    return " ";
  };
  rest = rest.replace(/https?:\/\/[^\s<>"']+/giu, readUrl);
  // The same link typed without "https://".
  for (const raw of schemelessPropertyUrls(rest)) readUrl(raw);
  rest = stripSchemelessPropertyUrls(rest);
  // A contact, vacancy or arbitrary URL may carry the actual requested action.
  if (unsupportedUrl) return null;
  const consumeSelector = () => { explicitProperty = true; return " "; };
  rest = rest.replace(words("(?:объект(?:а|у|е|ом|ы|ов|и|ро)?)\\s*[№#]?\\s*[1-9]\\d{0,8}"), consumeSelector);
  rest = rest.replace(/(?<![\p{L}\p{N}])[№#]\s*[1-9]\d{0,8}(?!\d)/gu, consumeSelector);
  rest = rest.replace(new RegExp(WEAK_PROPERTY_NUMBER_SOURCE, "giu"), consumeSelector);
  rest = rest.replace(new RegExp(OBJECT_CODE_NUMBER_SOURCE, "giu"), consumeSelector);
  const found = new Set<CustomerPropertyFactKind>();
  const consume = (pattern: RegExp, kinds: CustomerPropertyFactKind[]) => {
    rest = rest.replace(pattern, () => {
      for (const kind of kinds) found.add(kind);
      return " ";
    });
  };
  consume(PRICE, ["price"]);
  // Price per square metre is a price question; the renderer derives it from price and area.
  consume(words(PER_SQM_SOURCE), ["price"]);
  consume(ADDRESS, ["address"]);
  consume(BUILDER, ["builder"]);
  consume(CHARACTERISTICS, ["characteristics"]);
  consume(AVAILABILITY, ["availability"]);
  // A generic ad opener may concern a vacancy or service. It only implies
  // property facts when a subject is established independently of its wording.
  consume(DETAILS, options.hasPropertyContext || explicitProperty ? ["price", "address"] : []);
  rest = rest.replace(COURTESY, " ").replace(FRAMING, " ").replace(words("фаҳмем|фахмем|бо|без|с"), " ")
    .replace(/[.,!?;:…()[\]{}"'«»—–-]/gu, " ").trim();
  if (rest || !found.size) return null;
  return customerPropertyFactKindSchema.options.filter((kind) => found.has(kind));
}
