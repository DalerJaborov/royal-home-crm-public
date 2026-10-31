import { PROPERTY_CONDITION_LABELS, PROPERTY_TYPE_LABELS, formatPropertyCode } from "@royal-home/shared";
import type { PropertyStatus } from "../../../generated/prisma/client.js";
import { stripOwnerContact } from "../../../lib/ownerContact.js";
import { toTjs, type MoneyContext } from "../../../lib/money.js";
import { siteListingUrl } from "../../../lib/siteListingUrl.js";
import type { PropertyRefRecord } from "../../../lib/propertyRefLookup.js";
import type { AssistantActor } from "../actor.js";
import { safeField } from "./safeField.js";

/**
 * ОБЪЕКТ В ОТВЕТЕ ПОМОЩНИКА (П3, группа «read»): одна подача на find_property и
 * get_property_card. Права на контакт собственника — ТА ЖЕ функция, что у REST
 * (`stripOwnerContact`, lib/ownerContact.ts): руководитель с properties.viewOwners или
 * тот, кто ведёт объект сам; остальным — `ownerContactHidden`.
 */

/** Этапы подготовки и продажи — словами, как их называет агент (в shared подписей нет). */
const PROPERTY_STATUS_LABEL: Record<PropertyStatus, string> = {
  PENDING_REVIEW: "На проверке у маркетинга",
  AWAITING_PHOTOS: "Ожидает фото",
  AWAITING_VIDEO: "Ожидает видео",
  EDITING: "На монтаже",
  AVAILABLE: "В продаже",
  RESERVED: "Забронирован",
  SOLD: "Продан",
  WITHDRAWN: "Снят с продажи",
};

/** Ссылка для интерфейса (карточка объекта/заявки рисуется по `href`). Одна на все инструменты. */
export function propertyHref(shortId: number, query = ""): string {
  return `/properties/${shortId}${query}`;
}

export function presentPropertyBrief(p: PropertyRefRecord, money: MoneyContext) {
  const agent = p.assignedAgent ?? p.intakeAgent;
  return {
    id: p.id,
    code: formatPropertyCode(p.shortId),
    href: propertyHref(p.shortId),
    title: safeField(p.title),
    type: PROPERTY_TYPE_LABELS[p.type] ?? p.type,
    rooms: p.rooms,
    areaSqm: Number(p.areaSqm),
    floor: p.floor,
    totalFloors: p.totalFloors,
    district: p.district?.name ?? null,
    address: safeField(p.address, 200),
    price: Number(p.price),
    currency: p.currency,
    priceTjs: Math.round(toTjs(p.price, p.currency, money)),
    status: p.status,
    statusLabel: PROPERTY_STATUS_LABEL[p.status] ?? p.status,
    agent: agent?.fullName ?? null,
  };
}

/** Полная карточка: бриф + то, что агент открывает в карточке. */
export function presentPropertyCard(p: PropertyRefRecord, actor: AssistantActor, money: MoneyContext) {
  const owner = stripOwnerContact(p, actor.id, actor.permissions?.has("properties.viewOwners") ?? false);
  return {
    ...presentPropertyBrief(p, money),
    landAreaSotka: p.landAreaSotka ? Number(p.landAreaSotka) : null,
    condition: PROPERTY_CONDITION_LABELS[p.condition] ?? p.condition,
    amenities: p.amenities,
    landmark: safeField(p.landmark, 200),
    description: safeField(p.description, 600),
    owner: {
      // Контакт собственника — только тому, кому его отдаёт REST (stripOwnerContact).
      contact: owner.ownerContactHidden ? null : safeField(owner.ownerContact, 100),
      contactHidden: owner.ownerContactHidden,
    },
    intakeAgent: p.intakeAgent?.fullName ?? null,
    assignedAgent: p.assignedAgent?.fullName ?? null,
    reserved: p.reservedAt !== null,
    soldAt: p.soldAt ? p.soldAt.toISOString().slice(0, 10) : null,
    video: {
      instagramUrl: p.instagramUrl,
      handoffStatus: p.videoHandoffStatus,
      clipStatus: p.clipVideoStatus,
      approved: p.videoApprovedAt !== null,
    },
    publication: {
      onSite: p.publishedOnSite,
      siteUrl: siteListingUrl(p),
      channels: p.publishedChannels,
      scheduledAt: p.scheduledPublishAt ? p.scheduledPublishAt.toISOString() : null,
    },
    // Ссылки Somon в карточке объекта нет вовсе (поля в схеме нет) — не выдумывать.
    somonLink: "в карточке не хранится",
    createdAt: p.createdAt.toISOString().slice(0, 10),
  };
}
