import type { CustomerIntakeContext } from "./customerIntakeContext.js";

type BuyerPreferenceKey = "budgetMin" | "budgetMax" | "desiredRooms" | "desiredType";
export type OwnBuyerPreferences = Partial<Pick<CustomerIntakeContext, BuyerPreferenceKey>>;

const AMOUNT = String.raw`(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d{4,})`;
const CURRENCY = String.raw`(?:TJS|сомони|сомонӣ)`;
const EXPLICIT_INTENT = /(?:ищу|ищем|хочу\s+купить|хотим\s+купить|мне\s+нуж(?:на|ен|но)|нуж(?:на|ен|но)|куплю|планирую\s+купить|мой\s+бюджет|наш\s+бюджет|мехоҳам\s+(?:хар|хон)|хона\s+меҷӯям|меҷӯям|буҷети\s+(?:ман|мо)|буҷет)/iu;
const UNSAFE_CONTEXT = /["'‘’«»„“”`<>]|https?:\/\/|www\.|объявлен\p{L}*|listing|продав\p{L}*|арендатор\p{L}*|(?:^|[^\p{L}])(?:сосед\p{L}*|друг\p{L}*|брат\p{L}*|сестр\p{L}*|муж\p{L}*|жен\p{L}*)(?=$|[^\p{L}])|(?:^|\s)(?:он|она|они|его|её)(?:\s|$)|клиент\p{L}*|сотрудник\p{L}*|на\s+сайте|в\s+карточке|показали|прислали|сколько\s+стоит|цена\s+(?:этой|этого|вот)|эту?\s+(?:квартир\p{L}*|дом|объект|вариант)/iu;
const NEGATION_OR_CORRECTION = /(?:^|\s)не(?:\s|$)|(?:^|\s)ни(?:\s|$)|(?:^|\s)на\s+(?:хона|квартира|дом|замин|хар|мехоҳам)|(?:^|\s)а\s+не(?:\s|$)|поправк\p{L}*|передумал\p{L}*|ошиб\p{L}*|вместо|исправлен\p{L}*|хатогӣ|балки|дигар\s+не/iu;
const OWN_CORRECTION = /поправк\p{L}*|передумал\p{L}*|ошиб\p{L}*|исправлен\p{L}*|мне\s+не\s+(?:нуж\p{L}*|подходит)|не\s+хочу|дигар\s+не/iu;
const ROOM_REFERENCE = /(?:^|[^\p{L}\p{N}])\d{1,2}\s*[- ]?\s*(?:комнат(?:а|ы|н(?:ый|ая|ое|ую|ых|ые))?|комн\.?|хона(?:гӣ|г)?|ҳуҷра(?:гӣ)?|хучра(?:гӣ)?)(?=$|[^\p{L}\p{N}])/iu;
const ROOM_AVAILABILITY = /(?:^|[^\p{L}])(?:есть|имеется|бывает|в\s+наличии)\s+\d{1,2}\s*[- ]?\s*(?:комнат(?:а|ы|н(?:ый|ая|ое|ую|ых|ые))?|комн\.?|хона(?:гӣ|г)?|ҳуҷра(?:гӣ)?|хучра(?:гӣ)?)(?=$|[^\p{L}])/iu;

/**
 * Extracts only literal buyer wishes from authenticated customer text. The
 * result is suitable for a new lead's initial context; it is not an update
 * parser and intentionally leaves ambiguous language in requirementsNotes.
 */
export function deriveOwnBuyerPreferences(messages: readonly string[]): OwnBuyerPreferences {
  const found: Record<BuyerPreferenceKey, Set<string>> = {
    budgetMin: new Set(), budgetMax: new Set(), desiredRooms: new Set(), desiredType: new Set(),
  };
  const blocked = new Set<BuyerPreferenceKey>();
  const currency = new RegExp(CURRENCY, "iu");
  const roomPattern = /(?:^|[^\p{L}\p{N}])(\d{1,2})\s*[- ]?\s*(?:комнат(?:а|ы|н(?:ый|ая|ое|ую|ых|ые))?|комн\.?|хона(?:гӣ|г)?|ҳуҷра(?:гӣ)?|хучра(?:гӣ)?)(?=$|[^\p{L}\p{N}])/giu;
  const upperPattern = new RegExp(String.raw`(?<![\p{L}])(?:до|то)\s*(${AMOUNT})\s*(${CURRENCY})(?![\p{L}\p{N}])`, "giu");
  const lowerPattern = new RegExp(String.raw`(?<![\p{L}])(?:от|аз)\s*(${AMOUNT})\s*(${CURRENCY})(?![\p{L}\p{N}])`, "giu");
  const invalidate = (keys: BuyerPreferenceKey[]) => {
    for (const key of keys) { blocked.add(key); found[key].clear(); }
  };
  const invalidateBudget = () => invalidate(["budgetMin", "budgetMax"]);

  for (const raw of messages) {
    const text = raw.trim();
    if (!text || text.length > 1500 || UNSAFE_CONTEXT.test(text)) continue;
    if (ROOM_AVAILABILITY.test(text)) invalidate(["desiredRooms"]);
    const correction = NEGATION_OR_CORRECTION.test(text) && (EXPLICIT_INTENT.test(text) || OWN_CORRECTION.test(text));
    if (correction) {
      const affected: BuyerPreferenceKey[] = [];
      if (ROOM_REFERENCE.test(text) || ROOM_AVAILABILITY.test(text)) affected.push("desiredRooms");
      if (/квартир\p{L}*|дом|хонаи\s+заминӣ|коммерческ\p{L}*|офис\p{L}*|магазин\p{L}*|нежил\p{L}*|земл\p{L}*|участ\p{L}*|замин\p{L}*/iu.test(text)) affected.push("desiredType");
      if (/бюджет|буҷет|сомони|сомонӣ|TJS|USD|доллар\p{L}*|\$/iu.test(text)) affected.push("budgetMin", "budgetMax");
      invalidate(affected.length ? affected : ["desiredRooms", "desiredType", "budgetMin", "budgetMax"]);
      continue;
    }
    if (NEGATION_OR_CORRECTION.test(text) || !EXPLICIT_INTENT.test(text)) continue;

    const typeCandidates = [
      ...( /квартир\p{L}*/iu.test(text) ? ["APARTMENT"] : []),
      ...( /(?:^|[^\p{L}])(?:дом(?:а|е|ой)?|хонаи\s+заминӣ)(?=$|[^\p{L}])/iu.test(text) ? ["HOUSE"] : []),
      ...( /(?:коммерческ\p{L}*|офис\p{L}*|магазин\p{L}*|нежил\p{L}*)/iu.test(text) ? ["COMMERCIAL"] : []),
      ...( /(?:земл\p{L}*|участ\p{L}*|замин\p{L}*)/iu.test(text) ? ["LAND"] : []),
    ];
    const uniqueTypes = new Set(typeCandidates);
    if (uniqueTypes.size === 1) { blocked.delete("desiredType"); found.desiredType.add([...uniqueTypes][0]); }
    else if (uniqueTypes.size > 1) found.desiredType.add("!conflict");

    const roomCandidates = ROOM_AVAILABILITY.test(text) ? [] : [...text.matchAll(roomPattern)].map(match => Number(match[1])).filter(value => value > 0 && value <= 50);
    const uniqueRooms = new Set(roomCandidates);
    if (uniqueRooms.size === 1) { blocked.delete("desiredRooms"); found.desiredRooms.add(String([...uniqueRooms][0])); }
    else if (uniqueRooms.size > 1) found.desiredRooms.add("!conflict");

    const mentionsBudget = /(?:бюджет|буҷет|сомони|сомонӣ|TJS|USD|доллар\p{L}*|\$)/iu.test(text);
    const hasForeignCurrency = /(?:USD|доллар\p{L}*|\$)/iu.test(text);
    const hasTjs = currency.test(text);
    const hasRange = new RegExp(String.raw`(?:^|[^\p{L}])(?:от|аз)\s*${AMOUNT}[\s\S]{0,40}(?:^|[^\p{L}])(?:до|то)\s*${AMOUNT}`, "iu").test(text) ||
      new RegExp(String.raw`(?:^|[^\p{L}])(?:до|то)\s*${AMOUNT}[\s\S]{0,40}(?:^|[^\p{L}])(?:от|аз)\s*${AMOUNT}`, "iu").test(text);
    if (hasRange || hasForeignCurrency) { if (mentionsBudget) invalidateBudget(); continue; }
    if (!hasTjs) { if (mentionsBudget) invalidateBudget(); continue; }

    const upper = [...text.matchAll(upperPattern)];
    const lower = [...text.matchAll(lowerPattern)];
    if (upper.length + lower.length !== 1) {
      if (mentionsBudget && (upper.length + lower.length > 1 || /(?:бюджет|буҷет)/iu.test(text))) invalidateBudget();
      continue;
    }
    const match = upper[0] ?? lower[0];
    const matchStart = match.index ?? 0;
    const afterAmount = text.slice(matchStart, matchStart + match[0].length + 20);
    if (/(?:м\s*[²2]|кв\.?\s*м|за\s+квадрат|per\s+(?:sq\.?\s*)?m)/iu.test(afterAmount)) { invalidateBudget(); continue; }
    const amountText = match[1].replace(/[ \u00a0]/g, "");
    const amount = Number(amountText);
    if (!Number.isSafeInteger(amount) || amount <= 0) { invalidateBudget(); continue; }
    const key = upper.length ? "budgetMax" : "budgetMin";
    blocked.delete(key);
    found[key].add(String(amount));
  }

  const out: OwnBuyerPreferences = {};
  const putUnique = <K extends BuyerPreferenceKey>(key: K, convert: (value: string) => NonNullable<OwnBuyerPreferences[K]>) => {
    const values = found[key];
    if (values.size === 1 && !values.has("!conflict")) out[key] = convert([...values][0]) as never;
  };
  if (!blocked.has("desiredType")) putUnique("desiredType", value => value as NonNullable<OwnBuyerPreferences["desiredType"]>);
  if (!blocked.has("desiredRooms")) putUnique("desiredRooms", Number);
  if (!(found.budgetMin.size && found.budgetMax.size)) {
    if (!blocked.has("budgetMin")) putUnique("budgetMin", Number);
    if (!blocked.has("budgetMax")) putUnique("budgetMax", Number);
  }
  return out;
}
