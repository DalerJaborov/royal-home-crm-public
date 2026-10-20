import { prisma } from "../db.js";

/**
 * Из URL страницы сайта, с которой пришла заявка (`pageUrl` в POST /website-lead,
 * routes/webhooks.ts), достать объект CRM — Пачка 1 п.5, 11.09.2026: «клиент,
 * интересующийся конкретным объектом, безоговорочно уходит агенту этого объекта»,
 * и форма подбора на сайте — тот самый случай, когда объект уже известен по URL,
 * не только по тексту заявки.
 *
 * Обратная операция к `siteListingUrl` (lib/siteListingUrl.ts, строит ссылку из
 * объекта) — здесь наоборот, из ссылки восстанавливаем объект. Не объединено в
 * один файл: `siteListingUrl` — исходящая ссылка боту/агенту, эта функция —
 * разбор входящего URL от вебхука, разная область ответственности и разные
 * источники истины (там id объекта, здесь чужая строка).
 *
 * ДВА ФОРМАТА, ОБА УЖЕ ЖИВУТ В КОДЕ:
 *
 *  1. `/listing/by-crm/<id объекта в CRM>` — тот самый редирект, которым делится
 *     CRM (см. siteListingUrl.ts). Если посетитель попал на сайт по такой ссылке
 *     и со страницы объекта отправил форму, `pageUrl` донесёт этот путь как есть —
 *     id объекта уже известен буквально, поиск не нужен.
 *  2. Собственная карточка сайта — `Property.siteListingId` (Int, объекты,
 *     родившиеся на сайте) хранит числовой id объявления. В URL страницы объекта
 *     сайт кладёт этот же id последним числовым сегментом пути (типичная схема
 *     ЧПУ-адресов вида `/kvartiry/<slug>-<id>` или `/listing/<id>`) — ищем
 *     последнее число в пути и сверяем с siteListingId.
 *
 * Не нашли — не беда: пустой результат просто не добавляет явного шага, лид
 * идёт дальше по обычной лестнице (показ бота / совпадение по описанию / очередь).
 */
export async function resolvePropertyFromPageUrl(pageUrl: string | null | undefined): Promise<string | null> {
  if (!pageUrl) return null;
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    // Не абсолютный URL (относительный путь от фронта сайта) — работаем со строкой как есть.
    path = pageUrl.split(/[?#]/)[0];
  }

  const byCrmMatch = /\/listing\/by-crm\/([0-9a-f-]{8,})/i.exec(path);
  if (byCrmMatch) {
    const property = await prisma.property.findFirst({
      where: { id: byCrmMatch[1], deletedAt: null },
      select: { id: true },
    });
    if (property) return property.id;
  }

  // Id объявления — ТОЛЬКО последним сегментом пути: `/listing/4242` или ЧПУ
  // `/kvartiry/2-komnatnaya-dushanbe-4242`. Раньше бралось последнее число где
  // угодно, и `/blog/5-sovetov` давал объект №5: заявка уходила его агенту как
  // «объект назван явно» (ревизия бота 02.10.2026). Блог и новости — не объекты.
  const segments = path.split("/").filter(Boolean);
  if (segments.some((seg) => /^(?:blog|news|articles?|posts?|stati|novosti)$/i.test(seg))) return null;
  const last = segments[segments.length - 1] ?? "";
  const idMatch = /^(?:.*-)?(\d+)$/.exec(last);
  if (!idMatch) return null;
  const siteListingId = Number(idMatch[1]);
  if (!Number.isFinite(siteListingId) || siteListingId <= 0 || siteListingId > 2_147_483_647) return null;

  const bySiteListingId = await prisma.property.findFirst({
    where: { siteListingId, deletedAt: null },
    select: { id: true },
  });
  return bySiteListingId?.id ?? null;
}
