import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { formatPropertyCode, marketSideOf, propertyHasCondition, propertyHasMarket, PROPERTY_TYPE_LABELS } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { maskAssistantContacts } from "../lib/assistantContacts.js";
import { uploadsDir } from "../upload.js";
import { escapeHtml } from "./assistantReply.js";
import { isTelegramEnabled, sendHtmlMessage, sendMediaGroupFiles, sendPhotoFromDisk, TelegramApiError } from "./api.js";

const PHOTO_LIMIT = 4;
const PHOTO_MAX_BYTES = 10_000_000;
const CAPTION_MAX_CHARS = 1024;
const MAX_TELEGRAM_USER_ID = 2 ** 52 - 1;
const agentSelect = { fullName: true, isActive: true, telegramUserId: true, telegramChatId: true } as const;
const propertySelect = {
  shortId: true, type: true, rooms: true, areaSqm: true, landAreaSotka: true, price: true, currency: true,
  floor: true, totalFloors: true, address: true, landmark: true, stage: true, condition: true, marketType: true, status: true, instagramUrl: true,
  district: { select: { name: true, nameTj: true, city: true } },
  assignedAgent: { select: agentSelect }, intakeAgent: { select: agentSelect },
  photos: { orderBy: [{ order: "asc" }, { id: "asc" }], select: { url: true }, take: 24 },
} as const satisfies Prisma.PropertySelect;
type CardProperty = Prisma.PropertyGetPayload<{ select: typeof propertySelect }>;
type CardLanguage = "ru" | "tg";
type CardDelivery = "sent" | "unavailable" | "uncertain";

const words = {
  ru: {
    type: PROPERTY_TYPE_LABELS,
    condition: { NEEDS_REPAIR: "требует ремонта", GOOD: "хорошее состояние", EXCELLENT: "отличное состояние", NEW_BUILDING: "" },
    stage: { FOUNDATION: "котлован", SHELL: "коробка, без отделки", UNDER_CONSTRUCTION: "строится",
      ROUGH_FINISH: "черновая отделка", BUILT: "построен" },
    market: { NEW: "Новостройка", SECONDARY: "Вторичка" },
    status: { PENDING_REVIEW: "На проверке", AWAITING_PHOTOS: "Ждёт фото", AWAITING_VIDEO: "Ждёт видео",
      EDITING: "На монтаже", AVAILABLE: "", RESERVED: "В брони", SOLD: "Продан", WITHDRAWN: "Снят с продажи" },
    land: "сот.", landmark: "Ориентир", district: "район",
    instagram: "Смотреть в Instagram",
  },
  tg: {
    type: { APARTMENT: "Хона", HOUSE: "Хонаи ҳавлӣ", COMMERCIAL: "Ҷойи тиҷоратӣ", LAND: "Замин" },
    condition: { NEEDS_REPAIR: "таъмир лозим", GOOD: "ҳолаташ хуб", EXCELLENT: "ҳолаташ аъло", NEW_BUILDING: "" },
    stage: { FOUNDATION: "чоҳи таҳкурсӣ", SHELL: "деворҳояш сохта, бе таъмир", UNDER_CONSTRUCTION: "дар сохтмон",
      ROUGH_FINISH: "таъмири аввал шудааст", BUILT: "сохта шудааст" },
    market: { NEW: "Сохтмони нав", SECONDARY: "Хонаи пештар сохташуда" },
    status: { PENDING_REVIEW: "Дар санҷиш", AWAITING_PHOTOS: "Аксашро интизорем", AWAITING_VIDEO: "Видеояшро интизорем",
      EDITING: "Дар монтаж", AVAILABLE: "", RESERVED: "Дар банд", SOLD: "Фурӯхта шуд", WITHDRAWN: "Аз фурӯш гирифта шуд" },
    land: "сотиқ", landmark: "Нишона", district: "ноҳияи",
    instagram: "Дар Instagram бинед",
  },
};

/** Keep readable CRM facts, without giving free-form fields Telegram links or mentions. */
function cardField(value: string | null | undefined, limit: number): string {
  const clean = maskAssistantContacts(value ?? "")
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+|\b(?:[a-z\d-]+\.)+[a-z]{2,63}\b\S*|\S+@\S+|(?<!\S)@[a-z\d_]+/giu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function instagramLink(value: string | null): string | null {
  const match = /^https:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([a-z\d_-]{1,80})\/?(?:[?#][^\s]*)?$/iu.exec(value ?? "");
  return match ? `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/` : null;
}

function agentDisplay(agent: CardProperty["assignedAgent"]): string {
  const label = escapeHtml(cardField(agent?.fullName, 100));
  const id = agent?.telegramUserId;
  if (!label || !agent?.isActive || !id || id !== agent.telegramChatId
    || !/^[1-9]\d{0,15}$/u.test(id) || Number(id) > MAX_TELEGRAM_USER_ID) return label;
  return `<a href="tg://user?id=${id}">${label}</a>`;
}

function locationLine(property: CardProperty, language: CardLanguage): string {
  const address = cardField(property.address, 900);
  const city = cardField(property.district?.city, 100);
  const name = cardField(property.district?.name, 100);
  const nameTj = cardField(property.district?.nameTj, 100);
  const district = language === "tg" ? nameTj || name : name;
  const key = (value: string) => value.toLowerCase().replace(/^(?:г\.|город\s+|шаҳри?\s+|район\s+|ноҳияи?\s+)/u, "")
    .replace(/\s+(?:район|ноҳия)$/u, "").trim();
  const parts = address.split(/\s*,\s*/u).filter(Boolean);
  const districtNames = new Set([name, nameTj].filter(Boolean).map(key));
  const streetParts = parts.filter(part => !(city && key(part) === key(city)) && !districtNames.has(key(part)));
  const cityLine = city && !streetParts.some(part => key(part).startsWith(`${key(city)} `)) ? city : "";
  const hasDistrict = streetParts.some(part => [...districtNames].some(label => {
    const line = ` ${part.toLowerCase()} `;
    return ["район", "ноҳияи", "ноҳия"].some(word => line.includes(` ${word} ${label} `) || line.includes(` ${label} ${word} `));
  }));
  const districtLine = district && key(district) !== key(city) && !hasDistrict
    ? /(?:^|\s)(?:район|ноҳияи?)(?:\s|$)/iu.test(district) ? district : `${words[language].district} ${district}` : "";
  const location = [cityLine, districtLine, ...streetParts].filter(Boolean).join(", ");
  const landmark = cardField(property.landmark, 120);
  const period = (value: string) => /[.!?]$/u.test(value) ? value : `${value}.`;
  return escapeHtml([location ? period(location) : "", landmark ? period(`${words[language].landmark} ${landmark}`) : ""].filter(Boolean).join(" "));
}

function renderCard(property: CardProperty, language: CardLanguage): string {
  const text = words[language];
  const format = new Intl.NumberFormat(language === "tg" ? "tg-TJ" : "ru-RU", { maximumFractionDigits: 2 });
  const area = Number(property.areaSqm);
  const land = Number(property.landAreaSotka);
  const { rooms } = property;
  let type: string = text.type[property.type];
  if (rooms && rooms > 0) {
    if (language === "tg") type = property.type === "APARTMENT" ? `Хонаи ${rooms}-ҳуҷра` : `${type}, ${rooms} ҳуҷра`;
    else if (property.type === "APARTMENT") type = `${rooms}-комнатная квартира`;
    else if (property.type === "HOUSE") type = `${rooms}-комнатный дом`;
    else type = `${type}, ${rooms} комн.`;
  }
  const first = [type,
    area > 0 ? `${format.format(area)} м²` : "", land > 0 ? `${format.format(land)} ${text.land}` : ""].filter(Boolean).join(" · ");
  const price = Number(property.price);
  const { floor, totalFloors } = property;
  const floorLine = floor === null ? "" : language === "tg"
    ? (totalFloors ? `${floor} аз ${totalFloors} ошёна` : `Ошёнаи ${floor}`)
    : (totalFloors ? `${floor} из ${totalFloors} ${totalFloors === 1 ? "этажа" : "этажей"}` : `${floor} этаж`);
  const side = propertyHasMarket(property.type) ? marketSideOf(property) : null;
  const stage = property.stage ?? (property.marketType === "FOUNDATION_PIT" ? "FOUNDATION" : null);
  const finish = propertyHasCondition(property.type) ? [side ? text.market[side] : "",
    propertyHasMarket(property.type) && side !== "SECONDARY" && stage ? text.stage[stage] : text.condition[property.condition]].filter(Boolean).join(" · ") : "";
  const instagram = instagramLink(property.instagramUrl);
  const agent = agentDisplay(property.assignedAgent ?? property.intakeAgent);
  const priceLine = Number.isFinite(price) && price > 0 ? `💰 <b>${format.format(price)} ${property.currency === "USD" ? "$" : "сомони"}</b>` : "";
  const location = locationLine(property, language);
  return [`<b>${first}</b>`, [priceLine, floorLine].filter(Boolean).join(" · "), location ? `📍 ${location}` : "",
    finish ? `🏗 ${finish.charAt(0).toUpperCase()}${finish.slice(1)}` : "", text.status[property.status],
    instagram ? `🎬 <a href="${instagram}">${text.instagram}</a>` : "",
    [agent ? `👤 ${agent}` : "", formatPropertyCode(property.shortId)].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
}

async function localPropertyPhotos(photos: CardProperty["photos"]): Promise<string[]> {
  if (!photos.length) return [];
  const root = await realpath(uploadsDir).catch(() => null);
  if (!root) return [];
  const result = new Set<string>();
  for (const { url } of photos) {
    const name = /^\/uploads\/([a-z\d_.-]+\.(?:jpe?g|png|webp))$/iu.exec(url)?.[1];
    if (!name) continue;
    try {
      const file = await realpath(path.join(root, name));
      if (path.relative(root, file) !== name || result.has(file)) continue;
      const info = await stat(file);
      if (!info.isFile() || info.size === 0 || info.size > PHOTO_MAX_BYTES) continue;
      const { format, width, height, pages } = await sharp(file).metadata();
      if (!["jpeg", "png", "webp"].includes(format ?? "") || !width || !height || (pages ?? 1) !== 1
        || width + height > 10_000 || Math.max(width, height) / Math.min(width, height) > 20) continue;
      result.add(file);
      if (result.size === PHOTO_LIMIT) break;
    } catch {
      // Stale or corrupt photo records cannot prevent delivery of the other photos or the card.
    }
  }
  return [...result];
}

function confirmedMessage(value: unknown): boolean {
  const id = value && typeof value === "object" && "message_id" in value ? value.message_id : null;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

/** Staff only. The private/group adapter must authorize the audience and the chosen property first. */
export async function sendStaffPropertyCard(
  chatId: string, propertyId: string, language: CardLanguage, replyTo?: number, messageThreadId?: number,
): Promise<CardDelivery> {
  if (!isTelegramEnabled()) return "unavailable";
  const property = await prisma.property.findUnique({ where: { id: propertyId, deletedAt: null }, select: propertySelect })
    .catch(() => null);
  if (!property) return "unavailable";
  const html = renderCard(property, language);
  const visibleLength = html.replace(/<[^>]+>/gu, "").replace(/&(?:amp|quot|lt|gt);/gu, "x").length;
  const [first, ...others] = visibleLength <= CAPTION_MAX_CHARS ? await localPropertyPhotos(property.photos) : [];
  const options = { singleAttempt: true, replyTo, messageThreadId, parseMode: "HTML" } as const;
  try {
    if (first && others.length) {
      const result = await sendMediaGroupFiles(chatId, [
        { type: "photo", path: first, caption: html }, ...others.map(file => ({ type: "photo" as const, path: file })),
      ], 15_000, options);
      return Array.isArray(result) && result.length === others.length + 1 && result.every(confirmedMessage) ? "sent" : "uncertain";
    }
    const result = first
      ? await sendPhotoFromDisk(chatId, first, html, undefined, 15_000, options)
      : await sendHtmlMessage(chatId, html, replyTo, undefined, messageThreadId);
    return confirmedMessage(result) ? "sent" : "uncertain";
  } catch (error) {
    if (error instanceof TelegramApiError && [400, 401, 403, 404, 429].includes(error.errorCode ?? 0)) return "unavailable";
    return "uncertain";
  }
}
