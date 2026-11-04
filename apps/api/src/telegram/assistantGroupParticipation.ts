import { z } from "zod";
import { formatPropertyCode } from "@royal-home/shared";
import type { PropertyRefRecord } from "../lib/propertyRefLookup.js";

const CODE = String.raw`(?:об|ob|объект(?:а|е)?)\s*[-–—№#]?\s*(\d{1,8})`;
const RU = String.raw`(?:какая цена|сколько стоит|какой статус|ещ[её] актуален|есть ли фото|можно ссылку|где карточка|покажите карточку)`;
const TG = String.raw`(?:нархаш чанд|чанд пул|ҳоло дар фурӯш аст|вазъияташ чист|акс дорад|пайвандашро диҳед)`;
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
export const PROACTIVE_GROUP_INTERVAL_MS = 60_000;

export function requestedGroupParticipation(text: string): "quiet" | "resume" | null {
  const command = text.trim().replace(/[.!?]+$/u, "");
  if (/^(?:пожалуйста,?\s+)?(?:помолчи|тише|стоп|пока не отвечай|хомӯш бош)$/iu.test(command)) return "quiet";
  if (/^(?:пожалуйста,?\s+)?(?:продолжай|можешь отвечать|аз нав ҷавоб деҳ)$/iu.test(command)) return "resume";
  return null;
}

const STATUS = {
  ru: { PENDING_REVIEW: "на проверке", AWAITING_PHOTOS: "ожидает фото", AWAITING_VIDEO: "ожидает видео", EDITING: "на монтаже", AVAILABLE: "в продаже", RESERVED: "забронирован", SOLD: "продан", WITHDRAWN: "снят с продажи" },
  tg: { PENDING_REVIEW: "дар санҷиш", AWAITING_PHOTOS: "интизори акс", AWAITING_VIDEO: "интизори навор", EDITING: "дар таҳрир", AVAILABLE: "дар фурӯш", RESERVED: "банд шудааст", SOLD: "фурӯхта шудааст", WITHDRAWN: "аз фурӯш гирифта шудааст" },
} as const;

// Use only the verified card, price and stage. Never send a contact, private note or inferred detail.
export function proactivePropertyReply(p: Pick<PropertyRefRecord, "shortId" | "price" | "currency" | "status">, lang: "ru" | "tg"): string {
  const amount = Number(p.price);
  const card = `[${formatPropertyCode(p.shortId)}](/properties/${p.shortId})`;
  const currency = p.currency === "USD" ? "USD" : lang === "tg" ? "сомонӣ" : "сомони";
  const price = Number.isFinite(amount) && amount > 0 ? ` · ${amount.toLocaleString("ru-RU")} ${currency}` : "";
  return `${card} — ${STATUS[lang][p.status]}${price}.`;
}
