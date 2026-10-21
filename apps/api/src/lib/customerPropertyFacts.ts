import { createHash } from "node:crypto";
import { customerPropertyFactsSchema, customerPropertyCharacteristicsSchema, customerPropertyCharacteristicLines, customerPropertyAvailabilityLine,
  type CustomerPropertyFacts, type CustomerPropertyFactKind } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { BOT_OFFER_SELECT, botMayOffer, botOfferLink, type BotOfferFields } from "./propertyMatch.js";
import { safeCustomerPropertyLink } from "./customerPropertyUrls.js";

export const CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT = {
  type: true, rooms: true, areaSqm: true, landAreaSotka: true, floor: true, totalFloors: true, condition: true, marketType: true, stage: true,
} as const;
const select = {
  ...BOT_OFFER_SELECT, id: true, shortId: true, price: true, currency: true, updatedAt: true,
  ...CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT,
  district: { select: { name: true, city: true } },
} as const;
interface PublicFactsRow extends BotOfferFields {
  id: string; shortId: number; price: { toString(): string } | string;
  currency: string; updatedAt: Date; siteListingId: number | null;
  district: { name: string; city: string } | null;
  type?: string; rooms?: number | null; areaSqm?: { toString(): string } | string | null;
  landAreaSotka?: { toString(): string } | string | null; floor?: number | null; totalFloors?: number | null;
  condition?: string | null; marketType?: string | null; stage?: string | null;
}

/** No owner, house/apartment, private notes or inferred developer are selected. */
export function projectCustomerPropertyFacts(row: PublicFactsRow, channel: string): CustomerPropertyFacts | null {
  if (!botMayOffer(row)) return null;
  const amount = row.price.toString();
  const publicAddress = row.district ? [...new Set([row.district.name.trim(), row.district.city.trim()].filter(Boolean))].join(", ") || null : null;
  const link = botOfferLink(row, channel === "WEBSITE" ? "site" : "instagram");
  const publicLink = link ? safeCustomerPropertyLink(link) : null;
  const characteristics = row.type ? customerPropertyCharacteristicsSchema.parse({ type: row.type,
    rooms: row.rooms && row.rooms > 0 ? row.rooms : null,
    areaSqm: row.areaSqm && Number(row.areaSqm.toString()) > 0 ? row.areaSqm.toString() : null,
    landAreaSotka: row.landAreaSotka && Number(row.landAreaSotka.toString()) > 0 ? row.landAreaSotka.toString() : null,
    floor: row.floor ?? null, totalFloors: row.totalFloors && row.totalFloors > 0 ? row.totalFloors : null, condition: row.condition ?? null,
    marketType: row.marketType ?? null, stage: row.stage ?? null }) : undefined;
  const values = {
    propertyId: row.id, shortId: row.shortId,
    price: /^\d{1,14}(?:\.\d{1,2})?$/.test(amount) && Number(amount) > 0 ? amount : null,
    currency: row.currency, availability: row.status, publicAddress,
    addressPolicy: "district_city_only" as const, builder: null, publicLink,
    ...(characteristics ? { characteristics } : {}),
  };
  // Signature covers public facts and publication predicates, not unrelated
  // private edits/updatedAt alone. It changes when offerability changes too.
  const signature = createHash("sha256").update(JSON.stringify({ ...values,
    publishedOnSite: row.publishedOnSite, publishedChannels: [...row.publishedChannels].sort(),
  })).digest("hex");
  const parsed = customerPropertyFactsSchema.safeParse({ ...values, updatedAt: row.updatedAt.toISOString(), signature });
  return parsed.success ? parsed.data : null;
}

export async function readCustomerPropertyFacts(propertyId: string, channel: string, db: Pick<TxClient, "property"> = prisma): Promise<CustomerPropertyFacts | null> {
  const row = await db.property.findUnique({ where: { id: propertyId }, select });
  return row ? projectCustomerPropertyFacts(row, channel) : null;
}

function priceText(facts: CustomerPropertyFacts, language: "ru" | "tg"): string | null {
  if (!facts.price) return null;
  // Preserve exact decimal digits and stored currency; no guessed FX rate.
  const [integer, fraction] = facts.price.split(".");
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${fraction ? `,${fraction}` : ""} ${facts.currency === "USD" ? "USD" : language === "tg" ? "сомонӣ" : "сомони"}`;
}
export function renderCustomerPropertyFacts(facts: CustomerPropertyFacts, kinds: readonly CustomerPropertyFactKind[], language: "ru" | "tg"): string {
  const lines: string[] = [];
  const price = priceText(facts, language);
  for (const kind of [...new Set(kinds)]) {
    if (kind === "price") lines.push(language === "tg"
      ? price ? `Нархи объект №${facts.shortId}: ${price}.` : `Нархи объект №${facts.shortId} дар карточка нишон дода нашудааст.`
      : price ? `Цена объекта №${facts.shortId}: ${price}.` : `Цена объекта №${facts.shortId} в карточке не указана.`);
    if (kind === "address") lines.push(language === "tg"
      ? facts.publicAddress ? `Ҷойгиршавӣ: ${facts.publicAddress}.` : "Ҷойгиршавӣ дар карточка нишон дода нашудааст."
      : facts.publicAddress ? `Расположение: ${facts.publicAddress}.` : "Расположение в карточке не указано.");
    if (kind === "builder") lines.push(language === "tg"
      ? "Дар карточка маълумоти тасдиқшуда дар бораи сохтмончӣ нест."
      : "В карточке нет подтверждённых данных о застройщике.");
    if (kind === "characteristics") lines.push(...customerPropertyCharacteristicLines(facts.characteristics, language));
    if (kind === "availability") lines.push(customerPropertyAvailabilityLine(facts, language));
  }
  if (facts.availability === "RESERVED" && !kinds.includes("availability")) lines.push(language === "tg" ? "Объект ҳоло дар брон аст." : "Объект сейчас в брони.");
  return lines.join("\n");
}

export function renderMissingCustomerProperty(status: "ambiguous" | "missing" | "denied" | "pending", language: "ru" | "tg"): string {
  if (status === "ambiguous") return language === "tg"
    ? "Шумо кадом объектро дар назар доред? Рақами объект ё пайвандашро фиристед."
    : "Какой объект вы имеете в виду? Пришлите его номер или ссылку.";
  return language === "tg" ? "Объектро дақиқ муайян карда натавонистам. Рақами объект ё пайвандашро фиристед."
    : "Не удалось точно определить объект. Пришлите его номер или ссылку.";
}
