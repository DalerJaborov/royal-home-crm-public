/**
 * Публичный адрес объекта на сайте — то, что уходит клиенту в мессенджер.
 *
 * Id объявления на сайте знать НЕ нужно: у сайта есть универсальный редирект
 * `/listing/by-crm/<id объекта в CRM>` (api/boot.ts в репозитории сайта). Он находит
 * объявление по externalId и уводит на его страницу — работает для любого объекта,
 * опубликованного из CRM, независимо от того, когда его публиковали. Этой же ссылкой
 * бот даёт объекты клиентам в переписке (см. propertyLink в ai/leadQualifier.ts).
 *
 * Исключение — объект, РОДИВШИЙСЯ в админке сайта: у его строки на сайте нет
 * externalId (при публикации сайт просто снимает скрытие, см. crm-sync-router),
 * поэтому by-crm его не найдёт. Зато его собственный id известен с самого начала —
 * ссылку на него собираем напрямую.
 *
 * Неопубликованного объекта на сайте нет вовсе — ссылки у него не существует, и
 * вызывающий обязан это учесть (кнопка отправки для такого объекта недоступна).
 */
// `||`, а не `??`: в apps/api/.env.example переменная объявлена ПУСТОЙ строкой, и
// `??` считал бы её заданным значением. Тогда клиенту уходила ссылка без домена —
// «/listing/42» вместо «https://royalhome.tj/listing/42», то есть просто нерабочая.
// Поймано тестом site-listing-url на чистом стенде, где .env скопирован с примера.
const SITE_PUBLIC_URL = (process.env.SITE_PUBLIC_URL || "https://royalhome.tj").replace(/\/+$/, "");

export interface LinkableProperty {
  id: string;
  publishedOnSite: boolean;
  siteListingId: number | null;
}

export function siteListingUrl(property: LinkableProperty): string | null {
  if (!property.publishedOnSite) return null;
  if (property.siteListingId != null) return `${SITE_PUBLIC_URL}/listing/${property.siteListingId}`;
  return `${SITE_PUBLIC_URL}/listing/by-crm/${property.id}`;
}

/** Главная сайта — куда вести клиента, когда объекта по ссылке уже нет. */
export function siteHomeUrl(): string {
  return SITE_PUBLIC_URL;
}
