import type { Prisma } from "../generated/prisma/client.js";
import { logSystemError } from "./systemError.js";
import type { SiteSyncItemResult } from "@royal-home/shared";
import { prisma } from "../db.js";
import { crmPublicBase, publicUploadUrl } from "./crmPublicUrl.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { sitePropertyFacts } from './sitePropertyFacts.js';

/**
 * Pushes property publish/unpublish/sold state to the royalhome.tj website
 * (separate project, D:\Claude works\Royal Home website — receives at
 * POST /api/v1/crm/listings, see api/crm-sync-router.ts there). Mirrors the
 * existing site→CRM lead webhook pattern in reverse. Configured via
 * SITE_SYNC_URL / SITE_SYNC_API_KEY; when either is unset the integration is
 * simply off, so the CRM works standalone until the site side is deployed.
 */
const SITE_SYNC_URL = process.env.SITE_SYNC_URL;
const SITE_SYNC_API_KEY = process.env.SITE_SYNC_API_KEY;
// Public base URL for the CRM's own /uploads — the site is a different origin
// (royalhome.tj vs crm.royalhome.tj) so photo URLs sent to it must be absolute.
// Собирается в lib/crmPublicUrl.ts: тот же адрес нужен боту, отправляющему фото
// объекта клиенту в мессенджер, и двух копий этой сборки быть не должно.

export type SyncableProperty = Prisma.PropertyGetPayload<{
  include: { district: true; photos: true };
}>;

/**
 * Инвариант «несайтовый объект никогда не идёт на сайт» (offSite, решение
 * владельца 18.08.2026, docs/plan-18-08-private-listings-and-video.md §1) —
 * проверяется здесь ВТОРЫМ слоем, а не только в вызывающих роутах
 * (bulk-sync/publishAfterEditingComplete в properties.ts/propertyPipeline.ts):
 * это единственная функция, которая реально отправляет данные на сайт, и любой
 * новый вызывающий код автоматически получает защиту, не повторяя проверку сам.
 */
function offSitePropertiesIn(properties: SyncableProperty[]): SyncableProperty[] {
  return properties.filter((p) => p.offSite);
}

/**
 * Сколько снимков принимает сайт (`imageUrls: z.array(...).max(30)` в его
 * crm-sync-router.ts). Число живёт в чужом репозитории, поэтому держим его здесь
 * копией с явной подписью: превышение отвергает не один объект, а ВСЮ партию
 * публикации — схема разбирает тело целиком.
 */
export const SITE_MAX_IMAGE_URLS = 30;

/**
 * Столько символов принимает сайт (`description: z.string().max(5000)` в его
 * crm-sync-router.ts) — та же ловушка, что и с фото: превышение отвергает не
 * один объект, а ВСЮ партию, схема разбирает тело целиком. Текст без ограничения
 * длины (ИИ-описания, ручной ввод) режем на своей стороне до отправки.
 */
export const SITE_MAX_DESCRIPTION_LENGTH = 5000;


/**
 * Снимки объекта для сайта: обычные (обработанные) фото объекта в их порядке,
 * не больше `SITE_MAX_IMAGE_URLS`.
 *
 * ОБЛОЖЕК НА САЙТЕ НЕТ (решение владельца, 01.10.2026): фирменные обложки
 * `Property.socialCoverSquareUrl` / `socialCoverStoryUrl` нужны только для
 * Instagram, Telegram и Facebook. С 23.09.2026 до этого дня квадратная обложка
 * вставала первой картинкой объявления; эта логика убрана, обложка в список
 * для сайта не попадает ни при каких условиях (в том числе подписанная ссылка
 * из закрытой папки роликов). Поле обложки в `SyncableProperty` остаётся —
 * его читают другие каналы (каталог Meta, публикации), сайт его не трогает.
 *
 * Предел сайта режет список целиком: превышение отвергает не один объект, а
 * всю партию публикации.
 */
export function siteImageUrls(property: SyncableProperty): string[] {
  // Порядок — по `order` здесь, а не у вызывающего (глубокая проверка 02.10.2026,
  // D10): часть путей (закрытие сделки, разбор правки сайта) читала фото без
  // ORDER BY, и обложка объявления на сайте менялась случайно — порядок строк
  // Postgres без сортировки не гарантирован. Копия, чтобы не трогать массив
  // вызывающего.
  const ordered = [...property.photos].sort((a, b) => a.order - b.order);
  const photos = ordered.flatMap((p) => publicUploadUrl(p.url) ?? []);
  return photos.slice(0, SITE_MAX_IMAGE_URLS);
}

function toNum(d: unknown): number | null {
  return d === null || d === undefined ? null : Number(d);
}

export type SiteSyncAction = "publish" | "unpublish" | "sold" | "unsold" | "facts";

export type SiteSyncResult =
  | { ok: true; results: SiteSyncItemResult[] }
  | { ok: false; error: string };

/** usdToTjsRate — курс продажи 1 USD в TJS (см. lib/exchangeRate.ts). Обязателен
 * только для объектов в долларах; для объектов в TJS игнорируется. */
function toSitePayload(property: SyncableProperty, usdToTjsRate: number | null) {
  const priceInTjs =
    property.currency === "USD"
      ? Math.round(Number(property.price) * (usdToTjsRate as number))
      : Math.round(Number(property.price));
  return {
    ...sitePropertyFacts(property),
    title: property.title,
    // Сюда попадают только объекты на публикацию сайту — offSite (у которого
    // район может отсутствовать) publishedOnSite не бывает никогда (см.
    // routes/properties/moderation.ts), район здесь гарантирован.
    location: `${property.district!.name}, ${property.district!.city}`,
    price: priceInTjs,
    rooms: property.rooms ?? 1,
    area: Math.round(Number(property.areaSqm)),
    category: property.type,
    description: property.description?.slice(0, SITE_MAX_DESCRIPTION_LENGTH) ?? undefined,
    // Уже проданный объект можно публиковать (плашка «Продано» на сайте) —
    // без этого флага upsert создал бы его как продающийся.
    sold: property.status === "SOLD",
    // Сайт принимает не больше SITE_MAX_IMAGE_URLS снимков и разбирает ВСЮ партию
    // одной схемой: один объект с 31-м фото валил публикацию целиком, вместе с
    // соседними объектами, ответом «Неверные данные» — а причину пришлось бы искать
    // в чужом репозитории. Режем на своей стороне: лишние фото остаются в CRM,
    // на витрине их всё равно никто не пролистывает.
    imageUrls: crmPublicBase() ? siteImageUrls(property) : undefined,
    // Точные координаты (геокодированы по адресу) — сайт использует их напрямую вместо
    // приблизительного центра района, если они есть.
    lat: toNum(property.lat) ?? undefined,
    lng: toNum(property.lng) ?? undefined,
    instagramUrl: property.instagramUrl ?? undefined,
  };
}

/** Best-effort: объект уже опубликован на сайте — любое изменение, которое сайт
 * тоже должен увидеть (новый порядок/главное фото, добавленное или удалённое фото),
 * досылается само, без повторного ручного «Опубликовать». Никогда не бросает
 * исключение и не блокирует ответ — вызывающие делают void без .catch().
 *
 * С 27.08.2026 (чертёж Б5) — задание очереди site-resync: раньше единственная
 * попытка жила в HTTP-процессе, и отказ сайта (или деплой в эту секунду) молча
 * разъезжал витрину с CRM — задокументированная хроническая боль. dedupeKey на
 * объект схлопывает шквал правок (загрузили 10 фото подряд) в один прогон. */
export async function resyncPhotosIfPublished(propertyId: string, context: string): Promise<void> {
  try {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { publishedOnSite: true },
    });
    // Неопубликованный объект сайту не нужен — и задание ему не нужно тоже.
    if (!property?.publishedOnSite) return;
    await enqueueBackgroundJob({
      type: "site-resync",
      payload: { propertyId, context },
      dedupeKey: `site-resync:${propertyId}`,
      maxAttempts: SITE_RESYNC_MAX_ATTEMPTS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[siteSync] ${context}: объект ${propertyId} — постановка синхронизации:`, message);
    // Раньше только console.error — сбой постановки задания на сайт не попадал
    // в журнал ошибок (routes/errorLog.ts), который видит руководство: CRM и
    // сайт могли молча разъехаться (найдено аудитом 02.09.2026,
    // docs/audit-02-09-2026/07-deadcode.md).
    void logSystemError("site-sync", `Не удалось поставить в очередь досылку объекта на сайт (${context}): ${message}`);
  }
}

export const SITE_RESYNC_MAX_ATTEMPTS = 5;

/** Статусы, в которых объявление живёт на сайте: в продаже, в брони и проданный
 *  (с плашкой «Продано»). Снятый и любой этап подготовки на витрине не стоят. */
const SITE_LISTED_STATUSES: ReadonlySet<string> = new Set(["AVAILABLE", "RESERVED", "SOLD"]);

/** Может ли объект в этом статусе стоять на сайте (см. SITE_LISTED_STATUSES). */
export function isSiteListedStatus(status: string): boolean {
  return SITE_LISTED_STATUSES.has(status);
}

/**
 * Одна попытка досылки — тело задания site-resync (jobs/siteResync.ts).
 * Тихо завершается, когда досылать нечего (объект удалён или снят с сайта);
 * бросает на отказе сети или сайта — очередь ретраит, give-up кладёт честную
 * строку в журнал: молчаливый отказ синхронизации означает, что сайт и CRM
 * разъехались, а на экране здоровья при этом было зелено.
 */
export async function runSiteResyncAttempt(propertyId: string, context: string): Promise<void> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  if (!property?.publishedOnSite) return;
  // ОБЪЕКТ УШЁЛ В КОРЗИНУ, ПОКА ЗАДАНИЕ ЖДАЛО СВОЕЙ ОЧЕРЕДИ (22.09.2026, тот же
  // класс, что и отложенный контейнер Instagram). Одной проверки publishedOnSite
  // выше НЕ хватает: удаление снимает объект с сайта (unpublishBeforeTrash), но
  // саму отметку publishedOnSite намеренно не трогает (см. lib/trashProperty.ts) —
  // значит досылка с action "publish" вернула бы удалённый объект на витрину.
  // Окно реальное: у задания до пяти попыток с откатом до 16 минут.
  if (property.deletedAt) return;

  // ОБЪЕКТ НЕ В ПРОДАЖЕ — ДОСЫЛКА СНИМАЕТ, А НЕ ПУБЛИКУЕТ (глубокая проверка
  // 02.10.2026, D3). Снятие с сайта при уходе с продажи (PATCH, автостатус,
  // удаление фото) — одна попытка без повтора, и отметка publishedOnSite
  // сбрасывается только при её успехе. Сайт моргнул в эту секунду → отметка
  // осталась → следующая правка карточки слала сюда «publish» и возвращала
  // снятый объект на royalhome.tj живым объявлением (в снимке `sold` ложь у
  // всего, кроме SOLD). То же у досылки, ушедшей на повтор ДО снятия. Теперь
  // любая досылка доводит витрину до статуса CRM — и заодно повторяет
  // несостоявшееся снятие.
  if (!isSiteListedStatus(property.status)) {
    const removal = await syncPropertiesToSite([property], "unpublish");
    if (!removal.ok) throw new Error(`объект не снят с сайта (${context}): ${removal.error}`);
    const refused = removal.results.find((r) => !r.ok);
    if (refused) throw new Error(`сайт не снял объект (${context}): ${refused.error}`);
    await prisma.property.update({ where: { id: property.id }, data: { publishedOnSite: false } });
    return;
  }

  const result = await syncPropertiesToSite([property], "publish");
  if (!result.ok) throw new Error(`объект не дошёл до сайта (${context}): ${result.error}`);
  const failed = result.results.find((r) => !r.ok);
  if (failed) throw new Error(`сайт отклонил объект (${context}): ${failed.error}`);
}

/** Sends one bulk sync request for a batch of properties + a shared action. */
export async function syncPropertiesToSite(
  properties: SyncableProperty[],
  action: SiteSyncAction
): Promise<SiteSyncResult> {
  if (!SITE_SYNC_URL || !SITE_SYNC_API_KEY) {
    return { ok: false, error: "Синхронизация с сайтом не настроена (SITE_SYNC_URL/SITE_SYNC_API_KEY)" };
  }
  let usdToTjsRate: number | null = null;
  if (action === 'facts' && properties.some(p => p.offSite || p.deletedAt || !p.publishedOnSite || !isSiteListedStatus(p.status))) {
    return { ok: false, error: 'Характеристики можно дослать только для действующих публичных объектов' };
  }
  if (action === "publish") {
    const offSiteOnes = offSitePropertiesIn(properties);
    if (offSiteOnes.length > 0) {
      return {
        ok: false,
        error: `Несайтовый объект нельзя опубликовать на сайте: ${offSiteOnes.map((p) => p.title).join(", ")}`,
      };
    }
    if (!crmPublicBase()) {
      // Без публичного адреса CRM фото ушли бы на сайт битыми относительными
      // ссылками (или вовсе не ушли) — лучше честная ошибка, чем объекты без фото.
      return { ok: false, error: "Не настроен CRM_PUBLIC_URL — фото объектов не попадут на сайт" };
    }
    // Сайт показывает цены только в сомони — объекты в USD конвертируем по курсу
    // из Настроек (ручной либо ночной автообновлённый с alif.tj, см. exchangeRate.ts).
    // Без него публикацию честно блокируем, а не молча публикуем по случайному курсу.
    if (properties.some((p) => p.currency === "USD")) {
      let rate: number | null = null;
      try {
        const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { usdToTjsRate: true } });
        rate = settings?.usdToTjsRate ? Number(settings.usdToTjsRate) : null;
      } catch (err) {
        // Эта функция — контракт "результат вместо исключения" для всех вызывающих
        // (включая void-вызовы без .catch() в properties.ts) — БД-сбой тоже должен
        // вернуться как {ok:false}, а не пробросом сломать fire-and-forget цепочку.
        const message = err instanceof Error ? err.message : String(err);
        console.error("[siteSync] Не удалось прочитать курс USD→TJS:", message);
        // Тоже раньше только console.error — не попадало в журнал ошибок
        // руководства (docs/audit-02-09-2026/07-deadcode.md).
        void logSystemError("exchange-rate", `Не удалось прочитать курс USD→TJS для синхронизации с сайтом: ${message}`);
        return { ok: false, error: "Не удалось прочитать курс USD→TJS из базы" };
      }
      if (!rate || rate <= 0) {
        return {
          ok: false,
          error: "Курс USD→TJS не настроен — задайте его в Настройках (или дождитесь ночного автообновления с alif.tj)",
        };
      }
      usdToTjsRate = rate;
    }
    // Объекты, созданные в CRM, требуют фото перед публикацией. Объекты с сайта
    // (siteListingId) можно одобрять и без фото — на сайте покажется стильная заглушка.
    const noPhotos = properties.find((p) => p.photos.length === 0 && p.siteListingId == null);
    if (noPhotos) {
      return {
        ok: false,
        error: `Объект «${noPhotos.title}» без фото — добавьте хотя бы одно фото перед публикацией`,
      };
    }
    // Цена в TJS не спасает, если сам текст описания всё ещё называет сумму в
    // долларах (частый случай для ИИ-описаний, сгенерированных до смены валюты) —
    // на сайте должны быть только сомони, без USD-упоминаний в тексте.
    const usdInDescription = properties.find((p) => p.description && /\$|\bUSD\b|доллар/i.test(p.description));
    if (usdInDescription) {
      return {
        ok: false,
        error: `Объект «${usdInDescription.title}» — в описании упоминаются доллары, перепишите текст в сомони перед публикацией`,
      };
    }
  }

  const items = properties.map((p) => ({
    externalId: p.id,
    // Website itemSchema reads this beside externalId for every action.
    // Putting it inside data silently drops it during Zod parsing.
    // The same number is home_listing_id in the Meta catalogue feed.
    shortId: p.shortId,
    // Объект, созданный на САЙТЕ, не имеет там строки с этим externalId — сайт
    // найдёт его по siteListingId. Иначе «снять с публикации»/«продано» уходили в
    // никуда (сайт искал по externalId и не находил).
    ...(p.siteListingId != null ? { siteListingId: p.siteListingId } : {}),
    action,
    data: action === "publish" ? toSitePayload(p, usdToTjsRate) : undefined,
    ...(action === 'facts' ? { facts: sitePropertyFacts(p) } : {}),
  }));

  // 8с фиксированного таймаута хватало на 1 объект, но при массовой публикации
  // (до 50 сразу) сайт обрабатывает их последовательно (транзакция на объект) —
  // партия из 9+ объектов легко не укладывалась в 8с, fetch обрывался, и мы
  // получали "Сайт недоступен", хотя сайт просто ещё не закончил. Даём сайту
  // время пропорционально размеру партии, но остаёмся заметно ниже таймаута
  // прокси (~100с), чтобы при реальном падении сайта не зависать надолго.
  const timeoutMs = Math.min(60_000, 10_000 + properties.length * 3_000);

  try {
    const res = await fetch(`${SITE_SYNC_URL}/listings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": SITE_SYNC_API_KEY,
      },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const reason = body.error ?? `Сайт вернул ошибку ${res.status}`;
      void logSystemError("site-sync", `Синхронизация объектов с сайтом отклонена: ${reason}`);
      return { ok: false, error: reason };
    }
    const body = (await res.json()) as { results: SiteSyncItemResult[] };
    return { ok: true, results: body.results };
  } catch (err) {
    // err.message здесь — сырой текст fetch/undici ("fetch failed", "timeout" и т.п.),
    // не для показа пользователю: не пробрасываем его дальше вызывающему, только
    // понятную причину. Но НАСТОЯЩУЮ причину терять нельзя — до 22.09.2026 она
    // пропадала совсем (журнал видел только путь через очередь site-resync, а
    // этот прямой путь вызывает половина маршрутов, см. syncPropertiesToSite).
    const message = err instanceof Error ? err.message : String(err);
    void logSystemError("site-sync", `Синхронизация объектов с сайтом не удалась (${properties.length} объектов): ${message}`);
    return { ok: false, error: "Сайт недоступен" };
  }
}
