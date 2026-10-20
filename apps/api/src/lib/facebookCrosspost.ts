import { GRAPH_VERSION, fetchWithRetry, loadCredentials } from "../messengers/meta.js";
import { readJson, graphErrorMessage, PUBLISH_TIMEOUT_MS } from "./socialPublish.js";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * КРОССПОСТИНГ ВИДЕО НА ПАРТНЁРСКИЕ СТРАНИЦЫ FACEBOOK (28.09.2026,
 * docs/agent-briefs/facebook-crosspost-28-09.md).
 *
 * КАК ЭТО УСТРОЕНО У META. Партнёрская Страница один раз подтверждает связь у
 * себя (Settings → Crossposting) — после этого она попадает в наш список
 * `GET /{page-id}/crosspost_whitelisted_pages` (listCrosspostWhitelistedPages
 * ниже). После публикации видео на своей Странице (publishFacebookVideo,
 * lib/socialPublish.ts) мы РАЗРЕШАЕМ кросспостинг для нужных партнёров одним
 * вызовом (allowCrosspostForPages). Сам кросспост — на стороне партнёра, своим
 * токеном (`POST /{partner-page}/videos crossposted_video_id=…`) или кнопкой в
 * Publishing Tools → Crossposted videos; токенов партнёров у нас нет и не будет
 * — наша часть заканчивается на разрешении и списке.
 *
 * Reels (feat/facebook-reels-26-09, не в main на момент написания) используют
 * тот же video id и тот же вызов allowCrosspostForPages — отдельного пути для
 * Reels заводить не нужно.
 */

/**
 * `POST /{video-id}` с form-полем `allow_crossposting_for_pages` — JSON-массив
 * `{page_id, allow}`. Пустой список id — вызывающий не должен был звать вовсе
 * (см. crosspostAfterFacebookPublish), но на всякий случай отдаём `ok: true` и
 * ничего не отправляем: разрешать нечего.
 *
 * ИДЕМПОТЕНТНО. Meta просто перезаписывает список разрешённых Страниц тем же
 * значением — повторный вызов (например, и из onChannelPublished, и из
 * финального разбора applySucceededPublishResults на одной и той же публикации)
 * безопасен и не создаёт дублей.
 */
export async function allowCrosspostForPages(
  videoId: string,
  pageToken: string,
  pageIds: string[]
): Promise<{ ok: boolean; error?: string }> {
  if (pageIds.length === 0) return { ok: true };
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}`;
    const allow = pageIds.map((pageId) => ({ page_id: pageId, allow: true }));
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          allow_crossposting_for_pages: JSON.stringify(allow),
          access_token: pageToken,
        }).toString(),
      },
      PUBLISH_TIMEOUT_MS
    );
    const body = await readJson(res);
    if (!res.ok || body.success === false) {
      return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** `GET /{page-id}/crosspost_whitelisted_pages` — Страницы, которые подтвердили
 *  связь с нашей у себя в настройках. Бросает при отказе Graph API — вызывающий
 *  (маркетинг: проверка настройки, healthcheck) решает сам, как показать ошибку. */
export async function listCrosspostWhitelistedPages(
  pageId: string,
  pageToken: string
): Promise<{ id: string; name: string }[]> {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/crosspost_whitelisted_pages` +
    `?access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
  const body = await readJson(res);
  if (!res.ok) throw new Error(graphErrorMessage(body, `HTTP ${res.status}`));
  const data = (body.data as { id?: string; name?: string }[] | undefined) ?? [];
  return data
    .filter((row): row is { id: string; name?: string } => !!row.id)
    .map((row) => ({ id: row.id, name: row.name ?? row.id }));
}

/** Ключ в Property.publishedPostIds — тот же read-modify-write приём, что у
 *  writePendingMarker (socialPublish.ts), но значение здесь объект, не строка:
 *  список id, которым реально разрешили кросспостинг, и когда. */
const FACEBOOK_CROSSPOST_KEY = "FACEBOOK_CROSSPOST";

/**
 * ВЫЗЫВАЕТСЯ ПОСЛЕ УСПЕШНОЙ ПУБЛИКАЦИИ FACEBOOK (videoHandoff.ts,
 * applySucceededPublishResults) — не блокирует её: публикацию не ждать,
 * вызывающий код зовёт эту функцию через `void`.
 *
 * Пустой список партнёров в настройках — не отказ, а «кросспостинг не
 * настроен»: выходим тихо, без единого запроса к Graph API и без записи в
 * журнал.
 */
export async function crosspostAfterFacebookPublish(propertyId: string, videoId: string): Promise<void> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { facebookCrosspostPageIds: true },
  });
  const pageIds = settings?.facebookCrosspostPageIds ?? [];
  if (pageIds.length === 0) return;

  const creds = await loadCredentials();
  if (!creds.pageToken) return; // канал Facebook не настроен — разрешать нечем, публикация сама уже не прошла бы

  const result = await allowCrosspostForPages(videoId, creds.pageToken, pageIds);
  if (!result.ok) {
    await logSystemError(
      "meta",
      `Кросспостинг Facebook (объект ${propertyId}) не разрешён: ${result.error ?? "неизвестная ошибка Graph API"}`
    );
    return;
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { publishedPostIds: true },
  });
  if (!property) return; // объект удалили, пока запрос к Meta шёл — писать некуда
  const ids = { ...((property.publishedPostIds ?? {}) as Record<string, unknown>) };
  ids[FACEBOOK_CROSSPOST_KEY] = { allowed: pageIds, at: new Date().toISOString() };
  await prisma.property.update({
    where: { id: propertyId },
    data: { publishedPostIds: ids as Prisma.InputJsonValue },
  });
}

/** Форма значения FACEBOOK_CROSSPOST в Property.publishedPostIds — общая для
 *  бэкенда (эта функция) и фронтенда (PropertyVideoFixCard.tsx), чтобы каст на
 *  чтении не разъехался с тем, что реально пишет crosspostAfterFacebookPublish. */
export interface FacebookCrosspostMarker {
  allowed: string[];
  at: string;
}
