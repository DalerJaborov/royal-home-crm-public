/**
 * Что из ответов API service worker имеет право держать в кэше «api-cache».
 *
 * Чистая логика без workbox — её импортирует sw.ts, а проверяет юнит-тест
 * (`__tests__/swApiCache.test.ts`); в самом воркере тестировать нечем.
 *
 * ПОЧЕМУ СПИСОК РАЗРЕШЁННОГО, А НЕ СПИСОК ЗАПРЕЩЁННОГО (17.09.2026).
 *
 * До этого дня в «api-cache» ложился ЛЮБОЙ GET к /api/v1/* со статусом 200, а
 * стратегия NetworkFirst отдавала кэш не только без сети, но и когда сервер не
 * ответил за 4 секунды. Ключ записи — только адрес: ни Authorization, ни
 * сотрудник, ни версия сборки в него не входят. Из этого выросли два класса
 * поломок, оба «без ошибок»:
 *
 *  1. Ответ одного человека показывался другому (26.08.2026: /dashboard с
 *     финансами следующему вошедшему на том же устройстве). Заткнуто чисткой
 *     кэша при входе (store/auth.ts), но лишь для смены сессии.
 *  2. Конфигурация показывалась вчерашней (17.09.2026: после двух выкатов
 *     подряд «Настройки → Каналы связи» рисовали телефонию «не настроено» и
 *     TikTok «Сначала заполните Client key», хотя GET /api/v1/settings с
 *     сервера отвечал 200 полным телом). Во время выката api-контейнер
 *     перезапускается (ops/deploy.sh — stop + recreate), запросы этих секунд
 *     не укладываются в 4 секунды, и воркер отдаёт из кэша ответ до выката —
 *     без новых полей, а /settings ещё и «усечённый», если последним этот адрес
 *     на устройстве спрашивал рядовой сотрудник (сервер отдаёт ему только
 *     брендинг и курс). Лечилось только снятием воркера и удалением кэшей руками.
 *
 * Список запрещённого («всё, кроме settings/auth/me») эти дыры не закрывает:
 * следующий персональный или конфигурационный маршрут снова окажется в кэше
 * по умолчанию, и снова молча. Поэтому наоборот: кэшируется только то, что
 * агенту действительно нужно видеть без сети, и ничего сверх.
 */

/** Имя runtime-кэша ответов API. Его же чистит store/auth.ts при входе. */
export const API_CACHE_NAME = "api-cache";

/**
 * Разделы, которые обязаны открываться без сети хотя бы «как было в последний
 * раз» — ради этого офлайн-режим и существует (см. tests/e2e/offline.spec.ts):
 *
 *  - клиенты и объекты — карточки и списки, с которыми агент едет на показ;
 *  - сделки и календарь — что сегодня, с кем и когда;
 *  - дашборд — стартовый экран, чтобы приложение открылось не пустым;
 *  - районы и ориентиры — справочник для мастера объекта, который «помещается
 *    в PWA-кэш, подсказки работают офлайн» (docs/pult/theme-2026, мастер объекта).
 *
 * Чего здесь НЕТ и почему:
 *  - /settings — конфигурация компании, у ADMIN и рядового сотрудника разные тела
 *    под одним адресом, любая устаревшая копия ломает экран Настроек;
 *  - /auth, /me — сессия, права, уведомления, активный звонок: персональные и
 *    живые, кэшировать их — показывать чужое или вчерашнее; права без сети и так
 *    берутся из пресета роли в сохранённой сессии (lib/permissions.ts);
 *  - /events — бесконечный text/event-stream (12.09.2026: NetworkFirst ждал
 *    полный ответ и за 4 секунды уходил в кэш, где потока нет);
 *  - /interactions/:id/recording — записи разговоров с АТС: до двух минут
 *    ожидания и доступ «кто вёл разговор», а не «кто угодно с устройства»;
 *  - всё остальное (финансы, отчёты, команда, журналы, ИИ) — не нужно в поле,
 *    а в кэше живёт до суток и переживает выкат.
 */
export const OFFLINE_API_PATH_PREFIXES: readonly string[] = [
  "/api/v1/clients",
  "/api/v1/properties",
  "/api/v1/deals",
  "/api/v1/calendar",
  "/api/v1/dashboard",
  "/api/v1/districts",
  "/api/v1/landmarks",
];

/**
 * Попадает ли запрос под правило «api-cache»: только GET и только разрешённые
 * разделы. Префикс совпадает целым сегментом пути: /api/v1/clients и
 * /api/v1/clients/…, но не /api/v1/clientsXYZ.
 */
export function isOfflineCacheableApiRequest(pathname: string, method: string): boolean {
  if (method !== "GET") return false;
  return OFFLINE_API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/** Ровно то, что нужно решению «класть ли ответ в кэш» — без зависимости от Response. */
export interface CacheableResponseFacts {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
}

/**
 * Можно ли положить ответ в «api-cache». Под разрешёнными разделами живут не
 * только JSON: архив фото объекта (zip), видео объекта (mp4), выгрузка переписки
 * клиента — всё это большие файлы или выдачи под конкретное право, и сервер
 * помечает их `Content-Disposition: attachment` либо `Cache-Control: no-store`.
 * Поэтому в кэш идёт только JSON со статусом 200, который сервер не запретил
 * хранить.
 */
export function isCacheableApiResponse(facts: CacheableResponseFacts): boolean {
  if (facts.status !== 200) return false;
  if (!/^application\/json\b/i.test(facts.contentType ?? "")) return false;
  if (/\bno-store\b/i.test(facts.cacheControl ?? "")) return false;
  if (/^\s*attachment\b/i.test(facts.contentDisposition ?? "")) return false;
  return true;
}

export function responseFacts(response: Response): CacheableResponseFacts {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    contentDisposition: response.headers.get("content-disposition"),
  };
}
