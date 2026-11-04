import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { formatPropertyCode, PROPERTY_CONDITION_LABELS, PROPERTY_TYPE_LABELS } from "@royal-home/shared";
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
  floor: true, totalFloors: true, address: true, landmark: true, stage: true, condition: true, instagramUrl: true,
  assignedAgent: { select: agentSelect }, intakeAgent: { select: agentSelect },
  photos: { orderBy: [{ order: "asc" }, { id: "asc" }], select: { url: true }, take: 24 },
} as const satisfies Prisma.PropertySelect;
type CardProperty = Prisma.PropertyGetPayload<{ select: typeof propertySelect }>;
type CardLanguage = "ru" | "tg";
type CardDelivery = "sent" | "unavailable" | "uncertain";

const words = {
  ru: {
    type: PROPERTY_TYPE_LABELS,
    condition: { ...PROPERTY_CONDITION_LABELS, GOOD: "Хорошее состояние", EXCELLENT: "Отличное состояние" },
    stage: { FOUNDATION: "Котлован", SHELL: "Без черновой отделки", UNDER_CONSTRUCTION: "Строится",
      ROUGH_FINISH: "Черновая отделка", BUILT: "Построен" },
    price: "Цена", floor: "Этаж", rooms: "комн.", land: "сот.", landmark: "Ориентир", agent: "Агент",
    instagram: "Смотреть в Instagram",
  },
  tg: {
    type: { APARTMENT: "Хона", HOUSE: "Хонаи ҳавлӣ", COMMERCIAL: "Ҷойи тиҷоратӣ", LAND: "Замин" },
    condition: { NEEDS_REPAIR: "Таъмир лозим", GOOD: "Ҳолаташ хуб", EXCELLENT: "Ҳолаташ аъло", NEW_BUILDING: "Сохтмони нав" },
    stage: { FOUNDATION: "Чоҳи таҳкурсӣ", SHELL: "Бе таъмири аввал", UNDER_CONSTRUCTION: "Дар сохтмон",
      ROUGH_FINISH: "Таъмири аввал шудааст", BUILT: "Сохта шудааст" },
    price: "Нарх", floor: "Ошёна", rooms: "ҳуҷра", land: "сотиқ", landmark: "Нишона", agent: "Агент",
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

function renderCard(property: CardProperty, language: CardLanguage): string {
  const text = words[language];
  const format = new Intl.NumberFormat(language === "tg" ? "tg-TJ" : "ru-RU", { maximumFractionDigits: 2 });
  const area = Number(property.areaSqm);
  const land = Number(property.landAreaSotka);
  const first = [text.type[property.type], property.rooms && property.rooms > 0 ? `${property.rooms} ${text.rooms}` : "",
    area > 0 ? `${format.format(area)} м²` : "", land > 0 ? `${format.format(land)} ${text.land}` : ""].filter(Boolean).join(" · ");
  const price = Number(property.price);
  const floor = property.floor === null ? "" : `${property.floor}${property.totalFloors ? ` ${language === "tg" ? "аз" : "из"} ${property.totalFloors}` : ""}`;
  const address = escapeHtml(cardField(property.address, 900));
  const landmark = escapeHtml(cardField(property.landmark, 120));
  const location = [address, landmark ? `${text.landmark} ${landmark}` : ""].filter(Boolean).join(address.endsWith(".") ? " " : ". ");
  const condition = [property.stage ? text.stage[property.stage] : "", text.condition[property.condition]].filter(Boolean).join(" · ");
  const instagram = instagramLink(property.instagramUrl);
  const agent = agentDisplay(property.assignedAgent ?? property.intakeAgent);
  return [first, [Number.isFinite(price) && price > 0 ? `<b>${text.price} ${format.format(price)} ${property.currency === "USD" ? "$" : "сомони"}</b>` : "",
    floor ? `<b>${text.floor} ${floor}</b>` : ""].filter(Boolean).join(" · "),
  location, condition, instagram ? `<a href="${instagram}">${text.instagram}</a>` : "",
  [agent ? `${text.agent} ${agent}` : "", formatPropertyCode(property.shortId)].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
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
