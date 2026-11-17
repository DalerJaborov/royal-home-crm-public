/**
 * КЭШ ФАЙЛОВ /uploads (17.11.2026, аудит скорости P1).
 *
 * Было: `express.static(uploadsDir)` без настроек — каждый файл уходил с
 * `Cache-Control: public, max-age=0`. Фото и миниатюры в «Объектах», карточке,
 * на карте и на сайте royalhome.tj браузер перепроверял при каждом возврате на
 * экран (круг ≥135 мс на картинку), а Cloudflare их не держал вовсе.
 *
 * ДОЛГИЙ КЭШ — ТОЛЬКО ПО СПИСКУ, А НЕ «ВСЕМ, КРОМЕ». Долгий `immutable` честен
 * лишь для файла, чьё имя никогда не получает другого содержимого. Проверено по
 * всем местам записи (17.11.2026):
 *  · корень uploads — фото объектов и черновиков (`<uuid>.webp`: routes/properties/
 *    photos.ts, routes/properties/drafts.ts, lib/sellerMedia.ts, ai/photoEnhance.ts),
 *    логотип (`logo-<время>.webp`, routes/settings.ts), аватар сотрудника
 *    (`avatar-<id>-<время>.webp`, lib/agentAvatarFile.ts);
 *  · thumbs/ — миниатюры тех же фото под тем же `<uuid>.webp`.
 * Новая папка или новый писатель с постоянным именем в список НЕ попадает сам —
 * остаётся на прежнем поведении (перепроверка по ETag). Защита по умолчанию.
 *
 * НЕЛЬЗЯ ДОЛГО:
 *  · telephony/ — `greeting|moh|queue|agentDeclined.(wav|mp3)` перезаписываются
 *    под тем же именем из Настроек (routes/settings.ts), станция обязана видеть
 *    новый звук сразу → `no-cache`;
 *  · video/, automontage/, handoff/ — закрыты подписью или входом (app.ts,
 *    requireMediaAccess) → `private, no-cache`: ни Cloudflare, ни общий кэш не
 *    хранят их и не отдают другому человеку.
 *
 * Цена решения (назвать честно): удалённое фото ещё до 30 дней может отдаваться
 * из кэша Cloudflare по старому адресу. Адрес — случайный uuid, угадать его
 * нельзя, а сайт и CRM ссылку на удалённое фото больше не показывают.
 */

export const UPLOADS_IMMUTABLE_CACHE_CONTROL = "public, max-age=2592000, immutable";
export const UPLOADS_PRIVATE_CACHE_CONTROL = "private, no-cache";
export const UPLOADS_NO_CACHE = "no-cache";

const IMAGE_EXT = "(?:webp|jpe?g|png|avif|gif)";
/** Фото и миниатюры: файл прямо в корне uploads или в thumbs/, без вложенных папок. */
const IMMUTABLE_PATH = new RegExp(`^(?:thumbs/)?[^/]+\\.${IMAGE_EXT}$`, "i");
const PRIVATE_PATH = /^(?:video|automontage|handoff)\//i;
const TELEPHONY_PATH = /^telephony\//i;

/**
 * Заголовок Cache-Control для файла по его пути ОТНОСИТЕЛЬНО uploadsDir
 * (разделитель любой). null — оставить умолчание express.static
 * (`public, max-age=0` + ETag), как было до этой правки.
 */
export function uploadsCacheControl(relativePath: string): string | null {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.startsWith("../") || rel.split("/").includes("..")) return null;
  if (PRIVATE_PATH.test(rel)) return UPLOADS_PRIVATE_CACHE_CONTROL;
  if (TELEPHONY_PATH.test(rel)) return UPLOADS_NO_CACHE;
  if (IMMUTABLE_PATH.test(rel)) return UPLOADS_IMMUTABLE_CACHE_CONTROL;
  return null;
}
