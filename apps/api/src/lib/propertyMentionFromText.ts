import { extractMentionedPropertyNumber } from "../ai/propertyMentionGuard.js";

/**
 * ССЫЛКА НА НАШ САЙТ РЕШАЕТ, КАКОЙ ОБЪЕКТ ИМЕЛСЯ В ВИДУ (19.10.2026).
 *
 * Кнопка WhatsApp на сайте шлёт: «Здравствуйте! Интересует объект №45:
 * https://royalhome.tj/listing/45». «45» там — id объявления в базе САЙТА, а не
 * номер карточки CRM (shortId). Распознавание «объект №N» читало его как номер
 * карточки, и заявка уходила агенту ЧУЖОГО объекта №45 (с запертым владением).
 * Сайт скоро начнёт писать номер CRM, но старые сообщения, закешированные
 * страницы и скопированный текст будут приходить ещё месяцы.
 *
 * Правило одно и живёт здесь; им пользуются чат Meta, бот Telegram, пересланные
 * публикации и подсказка звонка:
 *  - /listing/by-crm/<id>  → объект с этим id (ссылка точнее любого номера);
 *  - /listing/<n>          → объект с siteListingId = n, а число n в тексте
 *                            НЕ считается номером карточки: для объектов,
 *                            созданных в CRM, CRM не хранит числовой id сайта,
 *                            и вернуть «карточку №n» было бы тихой подменой;
 *  - номер, отличный от n, и номер без ссылки — как раньше.
 */

/** Хост сайта берём из той же переменной, что и генератор ссылок (lib/siteListingUrl.ts):
 *  иначе на тестовом стенде свои же ссылки считались бы чужими. */
// `||`, а не `??` — по той же причине, что и в lib/siteListingUrl.ts: пустая строка
// из .env.example проходила бы как значение. Здесь цена ошибки выше, чем сломанная
// ссылка: с пустым хостом выражение ниже превращается в «/listing/by-crm/(...)» без
// домена вовсе и признаёт НАШИМ объектом ссылку с любого чужого сайта.
const SITE_HOST = (process.env.SITE_PUBLIC_URL || "https://royalhome.tj")
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "")
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A host inside another domain/path must never route a lead to our agent.
const SITE_LINK_START = `(?<![\\p{L}\\p{N}._/@-])(?:https?:\\/\\/)?${SITE_HOST}`;
const SITE_LINK_END = `(?=$|[/?#\\s<>"'.,;:!?)])`;

/** Ссылка на объект на нашем сайте: /listing/by-crm/<id CRM> — именно её присылает
 *  бот и печатает агент, поэтому она чаще всего и прилетает обратно. */
export function crmPropertyIdFromUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.match(new RegExp(`${SITE_LINK_START}/listing/by-crm/([A-Za-z0-9-]+)${SITE_LINK_END}`, "iu"));
  return match ? match[1] : null;
}

/** Ссылка на объект, РОДИВШИЙСЯ в админке сайта: /listing/<число> (см. siteListingUrl).
 *  У такого объекта нет externalId, и by-crm его не находит — идём по siteListingId. */
export function siteListingIdFromUrl(text: string | undefined | null): number | null {
  if (!text) return null;
  const match = text.match(new RegExp(`${SITE_LINK_START}/listing/(\\d+)${SITE_LINK_END}`, "iu"));
  const id = match ? Number(match[1]) : NaN;
  // Property.siteListingId is a PostgreSQL/Prisma Int.
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}

export interface PropertyMentionFromText {
  /** id карточки CRM из ссылки /listing/by-crm/<id>. */
  crmId: string | null;
  /** Числовой id объявления сайта из ссылки /listing/<n>. */
  siteListingId: number | null;
  /** Номер карточки CRM из слов клиента — без числа, которое есть id сайта. */
  number: string | null;
}

/**
 * Что клиент назвал в тексте: ссылку и/или номер, с уже снятой путаницей между
 * id сайта и номером карточки. Чистая функция — без базы.
 *
 * @param linkText где искать ссылку, если она может лежать не только в `text`
 *                 (вложение пересланного сообщения); по умолчанию — в `text`.
 */
export function readPropertyMention(text: string, linkText: string = text): PropertyMentionFromText {
  const crmId = crmPropertyIdFromUrl(linkText) ?? crmPropertyIdFromUrl(text);
  const siteListingId = siteListingIdFromUrl(linkText) ?? siteListingIdFromUrl(text);
  const raw = extractMentionedPropertyNumber(text);
  const number = raw != null && siteListingId != null && raw === String(siteListingId) ? null : raw;
  return { crmId, siteListingId, number };
}

/** Номер карточки из слов клиента — только когда он не повторяет id из ссылки на сайт. */
export function mentionedCardNumber(text: string, linkText: string = text): string | null {
  return readPropertyMention(text, linkText).number;
}
