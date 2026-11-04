import { z } from "zod";
import { formatPropertyCode } from "@royal-home/shared";
import type { PropertyRefRecord } from "../lib/propertyRefLookup.js";

const CODE = String.raw`(?:об|ob|объект(?:а|е)?)\s*[-–—№#]?\s*(\d{1,8})`;
const PROPERTY_CODE = new RegExp(CODE, "iu");
const RU = String.raw`(?:какая цена|сколько стоит|ещ[её] актуален)`;
const TG = String.raw`(?:нархаш чанд|чанд пул|ҳоло дар фурӯш аст)`;
const endings = "[?!.]*$";
const patterns = [
  { lang: "ru", re: new RegExp(String.raw`^(?:коллеги[,!]?\s+)?(?:(?:подскажите|кто подскажет)[,:]?\s+)?${RU}\s+(?:(?:у|по|на)\s+)?${CODE}${endings}`, "iu") },
  { lang: "ru", re: new RegExp(String.raw`^(?:по\s+)?${CODE}[,:]?\s+${RU}${endings}`, "iu") },
  { lang: "tg", re: new RegExp(String.raw`^${CODE}[,:]?\s+${TG}${endings}`, "iu") },
  { lang: "tg", re: new RegExp(String.raw`^${TG}\s+${CODE}${endings}`, "iu") },
] as const;

export function unaddressedPropertyQuestion(raw: string): { ref: string; lang: "ru" | "tg" } | null {
  if (!raw || raw.length > 160 || /[\r\n]/u.test(raw)) return null;
  const text = raw.trim().replace(/\s+/g, " ");
  for (const { re, lang } of patterns) {
    const match = re.exec(text);
    if (match && Number(match[1]) > 0) return { ref: `ОБ-${match[1]}`, lang };
  }
  return null;
}

const READ_START = /^(?:(?:коллеги|пожалуйста|лутфан)[,:]?\s+)*(?:подбер(?:и|ите)|найд(?:и|ите)|покаж(?:и|ите)|подскаж(?:и|ите)|провер(?:ь|ьте)|какие|какой|какая|сколько|где|когда|почему|есть ли|есть у нас|что (?:у меня|у нас|с)|нишон деҳ(?:ед)?|ёб(?:ед)?|пайдо кун(?:ед)?|санҷ(?:ед)?|кадом|чанд|кай|дар куҷо|оё|чӣ|чаро)(?:[, :]\s*|$)/iu;
const AVAILABILITY_QUESTION = /(?:^|\s)(?:есть|найд[её]тся|ҳаст|дорем)\s*\?$/iu;
const READ_SUBJECT = /(?:^|[^\p{L}\p{N}])(?:объект\p{L}*|об\s*-\s*\d+|ob\s*-\s*\d+|квартир\p{L}*|дом(?:а|ов|у|е)?|участ(?:ок|к\p{L}*)|клиент\p{L}*|показ\p{L}*|задач\p{L}*|хона\p{L}*|ҳуҷра\p{L}*|муштарӣ|муштарии|муштариён|намоиш\p{L}*|вазифа\p{L}*|(?:авто|пере)?монтаж\p{L}*|ролик\p{L}*|видео\p{L}*|навор\p{L}*|сомон\p{L}*)(?=$|[^\p{L}\p{N}])/iu;
const STATUS_WORDS = /(?:статус|почему|где (?:карточка|наш|мой)|у монтаж[её]ра|на монтаж[её]|на перемонтаж[её]|дар куҷо|дар кучо|вазъияташ|ҳоло ч[ӣи] хел|акс дорад|пайвандашро|есть ли фото|можно ссылку)/iu;
const STATUS_DELAY = /(?:недел\p{L}*|\d+\s+(?:дн\p{L}*|рӯз)|ҳафта|хафта)\s+.*(?:не готов|не получается|не сдел|дер|нашуд)|(?:почему|чаро)\s+.*(?:недел|ҳафта|хафта)/iu;

export function unaddressedReadRequest(text: string): boolean {
  if (!text || text.length > 500 || /[\r\n]|https?:\/\/|не\s+(?:отвечай(?:те)?|вмешивайся)|хомӯш бош/iu.test(text)) return false;
  return READ_SUBJECT.test(text) && (READ_START.test(text) || AVAILABILITY_QUESTION.test(text)
    || (text.endsWith("?") && STATUS_WORDS.test(text))
    || (PROPERTY_CODE.test(text) && STATUS_WORDS.test(text)) || STATUS_DELAY.test(text));
}

export type GroupConfirmationTool = "change_property_price" | "send_to_remake";

export function unaddressedConfirmationRequest(text: string): GroupConfirmationTool | null {
  // Without a direct address, accept only unambiguous instructions with an exact CRM code.
  if (!PROPERTY_CODE.test(text) || text.length > 350 || /[\r\n]|https?:\/\/|\?|(?:^|\s)(?:не|нет)\s|(?:накун|намон)/iu.test(text)) return null;
  const clean = text.replace(/^(?:пожалуйста|лутфан)[, ]+/iu, "");
  if (/^(?:поменяй(?:те)?|измени(?:те)?|обнови(?:те)?|поставь(?:те)?|снизь(?:те)?|подними(?:те)?)(?:\s|$)/iu.test(clean)
      && /цен[ауые]/iu.test(clean) && /\d\s*(?:сомон|тыс|tjs|usd|доллар)/iu.test(clean)) return "change_property_price";
  if (groupMontageCommand(clean)) return "send_to_remake";
  if (/(?:нарх|сомон)/iu.test(clean) && /\d\s*(?:сомон|ҳазор|хазор)/iu.test(clean)
      && /(?:^|\s)(?:мон(?:ед|ен)|бумон|иваз кун(?:ед)?)(?=$|[\s,.!])/iu.test(clean)) return "change_property_price";
  return null;
}

/** A short status question can refer to the object in the message it answers. */
export function groupStatusFollowUp(text: string, quoted: string): boolean {
  return READ_SUBJECT.test(quoted)
    && (STATUS_DELAY.test(text) || (text.endsWith("?") && STATUS_WORDS.test(text)))
    && !/https?:\/\/|не\s+(?:отвечай(?:те)?|вмешивайся)|хомӯш бош/iu.test(text);
}

/** Use only visible, unique object numbers from a reply. Never copy its stale result or instructions. */
export function groupPropertyRefs(text: string): string[] {
  return groupPropertyReferenceNumbers(text, 8).map(id => formatPropertyCode(id));
}

/** The same exact visible code identifies evidence at capture and at search. */
export function groupPropertyReferenceNumbers(text: string, maxDigits = 10): number[] {
  const ids = [...text.matchAll(/(?<![\p{L}\p{N}])(?:ОБ|OB)[\s\-–—№#]+(\d{1,10})(?![\p{L}\p{N}])/giu)]
    .filter(match => match[1].length <= maxDigits)
    .map(match => Number(match[1]))
    .filter(id => id > 0 && id <= 2_147_483_647);
  return [...new Set(ids)];
}

/** Only an explicit question about chat history can use archived evidence. */
export function groupHistoryQuestion(text: string, replyToMessageId?: number) {
  if (text.length > 200 || /[\r\n]|https?:\/\/|не\s+(?:отвечай(?:те)?|вмешивайся)|хомӯш бош/iu.test(text)) return null;
  const ask = /^(?:а\s+)?(?:что\s+(?:(?:уже|тут|здесь)\s+)*(?:писали|написали|говорили|просили|обсуждали)|(?:то ҳол\s+)?ч[ӣи]\s+(?:(?:ин ҷо|пештар)\s+)?(?:навиштанд|гуфтанд|пурсиданд))(?=$|[\s?!.])/iu;
  if (!ask.test(text)) return null;
  const refs = groupPropertyReferenceNumbers(text);
  if (refs.length === 1) return { propertyShortId: refs[0] };
  if (!refs.length && replyToMessageId) return { replyToMessageId };
  return null;
}

const MONTAGE_COMMAND = /^(?:(?:пожалуйста|лутфан)[, ]+)?(?:(?:отправь(?:те)?|перешли(?:те)?|верни(?:те)?)\s*(?:.*?\s)?(?:монтаж[её]ру|на (?:пере)?монтаж|на переделку)|(?:фиристон(?:ед)?|фиристед|равон кун(?:ед)?)\s*(?:.*?\s)?ба\s+(?:монтаж(?:[её]р)?|аз\s*нав\s*монтаж)|ба\s+монтаж(?:[её]р)?\s+(?:фиристон(?:ед)?|фиристед|равон кун(?:ед)?))(?=$|[\s,.!?:—–-])/iu;

export function groupMontageCommand(text: string): { tail: string; tajik: boolean } | null {
  const match = MONTAGE_COMMAND.exec(text.trim());
  if (!match || /(?:^|\s)(?:не|нет)\s|(?:нафирист|накун)/iu.test(text)) return null;
  return {
    tail: text.trim().slice(match[0].length).replace(/^[\s,.!?:—–-]+/u, "").trim(),
    tajik: /(?:фирист|равон кун)/iu.test(match[0]),
  };
}

export function isGroupPropertyFollowUp(text: string): boolean {
  return /^(?:а\s+)?(?:сколько\s+(?:стоит|дней|часов)|какая\s+цена|какой\s+статус|где\s+(?:он|она|ролик|объект)|что\s+с\s+(?:ним|ней|роликом|объектом)|(?:покажи|скинь|пришли)\s+(?:фото|фотки|карточку)|нархаш\s+чанд|чанд\s+(?:рӯз|руз|соат)|дар\s+ку[ҷч]о|акс(?:аш|ҳояш)?\s+(?:ҳаст|дорад))/iu.test(text);
}

/** A standalone follow-up has no new subject. The group window supplies only the property number. */
export function isShortPropertyFollowUp(text: string): boolean {
  return /^(?:а\s+)?(?:сколько\s+(?:стоит|(?:дней|часов)(?:\s+уже)?(?:\s+на\s+монтаже)?)|какая\s+цена|какой\s+статус|где\s+(?:он|она|ролик)|что\s+с\s+(?:ним|ней|роликом)|(?:покажи|скинь|пришли)\s+(?:фото|фотки|карточку)|(?:есть|можно)\s+фото|нархаш\s+чанд(?:\s+шуд)?|чанд\s+(?:р[ӯу]з|соат)(?:\s+(?:шуд|дар монтаж аст))?|дар\s+ку[ҷч]о(?:ст)?|акс(?:аш|ҳояш)?\s+(?:ҳаст|дорад))\s*[?!.]*$/iu.test(text);
}

export const GROUP_REMAKE_REASON_QUESTION = {
  ru: (ref: string) => `Что поправить в ролике ${ref}?`,
  tg: (ref: string) => `Дар навори ${ref} чиро иваз кунем?`,
};

export function isGroupRemakeReasonQuestion(text: string): boolean {
  return /^(?:Что поправить в ролике ОБ-|Дар навори ОБ-)/u.test(text);
}

const serviceUser = z.object({ id: z.number().int(), is_bot: z.boolean(), username: z.string().optional() });
const serviceMembers = z.array(serviceUser).min(1).max(200);
export function groupMembershipEvent(added: unknown, left: unknown, username: string): "bot-added" | "bot-left" | "people-joined" | null {
  const ourBot = (user: z.infer<typeof serviceUser>) => user.is_bot && user.username?.toLowerCase() === username.toLowerCase();
  const departed = serviceUser.safeParse(left);
  if (departed.success && ourBot(departed.data)) return "bot-left";
  const arrivals = serviceMembers.safeParse(added);
  if (!arrivals.success) return null;
  if (arrivals.data.some(ourBot)) return "bot-added";
  return arrivals.data.some(member => !member.is_bot) ? "people-joined" : null;
}
export const GROUP_WELCOME_INTERVAL_MS = 60_000;
export const GROUP_QUIET_MS = 30 * 60_000;
export const PROACTIVE_GROUP_INTERVAL_MS = 12_000;

export function requestedGroupParticipation(text: string): "quiet" | "resume" | null {
  const command = text.trim().replace(/[.!?]+$/u, "");
  if (/^(?:пожалуйста,?\s+)?(?:помолчи|молчи|тише|стоп|(?:пока )?не отвечай|хомӯш бош)$/iu.test(command)) return "quiet";
  if (/^(?:пожалуйста,?\s+)?(?:продолжай|можешь отвечать|аз нав ҷавоб деҳ)$/iu.test(command)) return "resume";
  return null;
}

const STATUS = {
  ru: { PENDING_REVIEW: "на проверке", AWAITING_PHOTOS: "ожидает фото", AWAITING_VIDEO: "ожидает видео", EDITING: "на монтаже", AVAILABLE: "в продаже", RESERVED: "забронирован", SOLD: "продан", WITHDRAWN: "снят с продажи" },
  tg: { PENDING_REVIEW: "ҳоло месанҷанд", AWAITING_PHOTOS: "ҳоло аксашро интизоранд", AWAITING_VIDEO: "ҳоло наворашро интизоранд", EDITING: "навораш ҳоло тайёр нест", AVAILABLE: "дар фурӯш", RESERVED: "банд аст", SOLD: "фурӯхта шуд", WITHDRAWN: "аз фурӯш гирифтанд" },
} as const;

// Use only the verified card, price and stage. Never send a contact, private note or inferred detail.
export function proactivePropertyReply(p: Pick<PropertyRefRecord, "shortId" | "price" | "currency" | "status">, lang: "ru" | "tg"): string {
  const amount = Number(p.price);
  const card = `[${formatPropertyCode(p.shortId)}](/properties/${p.shortId})`;
  const currency = p.currency === "USD" ? "USD" : lang === "tg" ? "сомонӣ" : "сомони";
  const price = Number.isFinite(amount) && amount > 0 ? ` · ${amount.toLocaleString("ru-RU")} ${currency}` : "";
  return `${card} — ${STATUS[lang][p.status]}${price}.`;
}
