/**
 * ДОЗАВЕРШЕНИЕ ОТЛОЖЕННЫХ КОНТЕЙНЕРОВ INSTAGRAM (21.09.2026, случай №111 — объект
 * №111, публикация упала «Видео не обработалось за отведённое время ожидания»,
 * пока на Meta одновременно легли два объекта (№111, №112) плюс история; сам
 * ролик крошечный (22.3 с, 26.8 МБ) — дело было не в весе, а в очереди у Meta).
 *
 * lib/socialPublish.ts::waitForInstagramContainerReady теперь ждёт дольше
 * (~4 мин 42 с лесенкой опроса, см. CONTAINER_POLL_INTERVALS_MS там же), но и
 * этого может не хватить — вместо того чтобы бросить готовую (или почти готовую)
 * работу, rememberInstagramContainer сохраняет `creation_id` в
 * PendingInstagramContainer. Эта функция — фоновый проход, который доводит такие
 * контейнеры до публикации сам, как только Meta закончит обработку.
 *
 * Зарегистрирован в общем крон-файле (cron.ts, scheduleTracked) — НЕ отдельным
 * самодельным планировщиком (правило чертежа №5: фоновая работа — через общий
 * крон/очередь, не через свой setInterval).
 */
import { prisma } from "../db.js";
import { loadCredentials, instagramTokenIdentity, instagramApiUrl, instagramRequest, fetchWithRetry, GRAPH_VERSION } from "../messengers/meta.js";
import { readJson, graphErrorMessage, fetchInstagramPermalink, PUBLISH_TIMEOUT_MS } from "./socialPublish.js";
import { applySucceededPublishResults, handoffStatusBlockReason } from "./videoHandoff.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * СРОК ЖИЗНИ КОНТЕЙНЕРА У META — задокументированное значение из официальной
 * документации Meta (Instagram Platform → Content Publishing, раздел «Container
 * IDs are valid for 24 hours», developers.facebook.com/docs/instagram-platform/
 * instagram-graph-api/guides/content-publishing, проверено 21.09.2026): контейнер
 * можно опрашивать/публиковать в течение 24 часов с момента создания, после чего
 * Meta считает его невалидным. Брошенный контейнер старше этого срока публиковать
 * не пытаемся — помечаем протухшим и пишем в журнал, а не долбим Graph API
 * заведомо мёртвым id.
 */
export const INSTAGRAM_CONTAINER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * ОКНО «У КОНТЕЙНЕРА ЕСТЬ ЖИВОЙ ХОЗЯИН» (22.09.2026). С этого дня контейнер
 * записывается в PendingInstagramContainer СРАЗУ после создания, а не только
 * когда живой процесс сдался по времени (см. rememberInstagramContainer в
 * lib/socialPublish.ts и причину там же). Значит этот проход видит и те
 * контейнеры, которые прямо сейчас ждёт живой HTTP-запрос, — и без окна ниже мог
 * бы опубликовать контейнер ВТОРЫМ, наперегонки с ним.
 *
 * Живой процесс отмечается в `lastCheckedAt` на каждом шаге своего опроса (шаг
 * не длиннее 30 с плюс таймаут самого запроса, PUBLISH_TIMEOUT_MS = 60 с), то
 * есть у живого хозяина отметка свежее ~1,5 мин. Три минуты — запас вдвое.
 * Меньше тика крона (5 минут), поэтому собственная отметка прохода не заставляет
 * его пропустить следующий тик.
 */
export const INSTAGRAM_CONTAINER_OWNER_STALE_MS = 3 * 60 * 1000;

/**
 * ОБЪЕКТ УШЁЛ В КОРЗИНУ — ЕГО КОНТЕЙНЕР ГАСНЕТ ВМЕСТЕ С НИМ (22.09.2026).
 *
 * Тот же класс, что «осиротевшие спутники» разведки 07.09.2026
 * (revokePropertyShareLinks, releaseVideoHandoffForTrashed в lib/videoHandoff.ts):
 * у удаления объекта есть хвост работы, который продолжает жить сам по себе.
 * Здесь он дороже остальных — контейнер живёт у Meta 24 часа, и фоновый проход
 * ниже опубликовал бы ролик удалённого объекта на ПУБЛИЧНОЙ странице агентства
 * через несколько часов после того, как его убрали. Заметить это можно было
 * только глазами в Instagram.
 *
 * Зовётся из lib/trashProperty.ts вместе с остальными спутниками. Проход ниже
 * всё равно проверяет объект сам: объект может уйти в Корзину и мимо
 * trashProperties (вебхук сайта), а между гашением и тиком есть окно.
 */
export async function cancelPendingInstagramContainersForTrashed(propertyIds: string[]): Promise<number> {
  if (propertyIds.length === 0) return 0;
  const { count } = await prisma.pendingInstagramContainer.updateMany({
    where: { propertyId: { in: propertyIds }, status: "PENDING" },
    data: {
      status: "CANCELLED",
      resolvedAt: new Date(),
      error: "Объект удалён в Корзину, пока контейнер ждал обработки у Meta — публикация отменена",
    },
  });
  return count;
}

/** Одна проверка статуса — без цикла ожидания (тот, что в socialPublish.ts,
 *  нужен только сразу после создания контейнера при живом HTTP-запросе; здесь
 *  тик крона сам приходит каждые 5 минут, повторный опрос внутри тика не нужен). */
async function checkContainerStatus(
  containerId: string,
  token: string
): Promise<{ status: "FINISHED" | "ERROR" | "IN_PROGRESS"; error?: string }> {
  const statusReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${containerId}?fields=status_code`), token);
  const statusRes = await fetchWithRetry(statusReq.url, { headers: statusReq.headers }, PUBLISH_TIMEOUT_MS);
  const statusBody = await readJson(statusRes);
  if (!statusRes.ok) {
    return { status: "IN_PROGRESS", error: graphErrorMessage(statusBody, `HTTP ${statusRes.status}`) };
  }
  const statusCode = statusBody.status_code as string | undefined;
  if (statusCode === "FINISHED") return { status: "FINISHED" };
  if (statusCode === "ERROR") return { status: "ERROR", error: "Meta не смогла обработать видео (status_code: ERROR)" };
  return { status: "IN_PROGRESS" };
}

async function publishContainer(containerId: string, igUserId: string, token: string): Promise<{ ok: true; postId: string } | { ok: false; error: string }> {
  const publishReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media_publish`), token);
  const publishRes = await fetchWithRetry(
    publishReq.url,
    {
      method: "POST",
      headers: { ...publishReq.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId }),
    },
    PUBLISH_TIMEOUT_MS
  );
  const publishBody = await readJson(publishRes);
  const postId = publishBody.id as string | undefined;
  if (!publishRes.ok || !postId) {
    return { ok: false, error: graphErrorMessage(publishBody, `HTTP ${publishRes.status}`) };
  }
  return { ok: true, postId };
}

/**
 * Один тик — разбирает ВСЕ незакрытые записи PENDING. Каждая проверяется и (при
 * готовности) публикуется независимо от остальных — падение одной не должно
 * останавливать проход по другим объектам. Раз в 5 минут (см. регистрацию в
 * cron.ts) — контейнер живёт 24 часа, частый опрос не нужен и тратил бы квоту API.
 *
 * @returns сколько контейнеров дозавершили публикацию, отклонены Meta, признаны
 *          протухшими и отменены вместе с удалённым объектом — для строки в лог
 *          крона, как у соседних тиков.
 */
export async function runInstagramPendingContainersTick(): Promise<{
  published: number;
  rejected: number;
  expired: number;
  cancelled: number;
}> {
  const pending = await prisma.pendingInstagramContainer.findMany({ where: { status: "PENDING" } });
  let published = 0;
  let rejected = 0;
  let expired = 0;
  let cancelled = 0;

  // ОБЪЕКТЫ, КОТОРЫХ БОЛЬШЕ НЕТ — одним запросом на весь проход, а не по
  // карточке в цикле. Гашение при удалении (cancelPendingInstagramContainers-
  // ForTrashed выше) закрывает обычный путь, но не все: объект уходит в Корзину
  // и вебхуком сайта, и между гашением и этим тиком есть окно. Цена пропуска —
  // ролик удалённого объекта на публичной странице агентства, поэтому проверка
  // стоит и здесь тоже.
  const aliveStatus = new Map(
    (
      await prisma.property.findMany({
        where: { id: { in: [...new Set(pending.map((row) => row.propertyId))] }, deletedAt: null },
        select: { id: true, status: true },
      })
    ).map((p) => [p.id, p.status] as const)
  );

  for (const row of pending) {
    try {
      if (!aliveStatus.has(row.propertyId)) {
        await prisma.pendingInstagramContainer.update({
          where: { id: row.id },
          data: {
            status: "CANCELLED",
            resolvedAt: new Date(),
            error: "Объекта больше нет (удалён в Корзину), пока контейнер ждал обработки — публикация отменена",
          },
        });
        cancelled++;
        continue;
      }

      // ПРОДАН / СНЯТ / ЗАБРОНИРОВАН, пока контейнер ждал Meta (25.09.2026, Б1):
      // тот же предикат, что у задания публикации (lib/videoHandoff.ts). Гасим
      // Reels, видео-историю, карточку объекта и «цена снижена» — всё это реклама
      // живого объекта. Не трогаем только печать «Продано» (storyKind SOLD): её
      // ставит человек кнопкой именно для такого объекта. Раньше здесь гасились
      // лишь Reels и видео-история, а CARD и PRICE_DROP уходили в сеть про проданную
      // квартиру: комментарий оправдывал это тем, что «Продано» идёт через PRICE_DROP,
      // но с 28.09 у него свой kind (аудит 04.10.2026, PUB03).
      const propertyStatus = aliveStatus.get(row.propertyId);
      const statusBlock = propertyStatus ? handoffStatusBlockReason(propertyStatus) : null;
      const advertisesProperty = row.kind === "REEL" || row.storyKind !== "SOLD";
      if (statusBlock && advertisesProperty) {
        await prisma.pendingInstagramContainer.update({
          where: { id: row.id },
          data: { status: "CANCELLED", resolvedAt: new Date(), error: `${statusBlock} Публикация отменена.` },
        });
        void logSystemError("meta", `Instagram (объект ${row.propertyId}): отложенный контейнер отменён — ${statusBlock}`);
        cancelled++;
        continue;
      }

      const ageMs = Date.now() - row.createdAt.getTime();
      if (ageMs > INSTAGRAM_CONTAINER_MAX_AGE_MS) {
        await prisma.pendingInstagramContainer.update({
          where: { id: row.id },
          data: {
            status: "EXPIRED",
            resolvedAt: new Date(),
            error: "Контейнер старше 24 часов (срок жизни у Meta) — публикация отменена",
          },
        });
        void logSystemError(
          "meta",
          `Instagram (объект ${row.propertyId}): отложенный контейнер протух (старше 24 часов, срок жизни у Meta) — публикация отменена, потребуется заново пройти монтаж.`
        );
        expired++;
        continue;
      }

      // Контейнер ещё ждёт живой процесс — не вмешиваемся (см.
      // INSTAGRAM_CONTAINER_OWNER_STALE_MS выше). Проверка идёт ПОСЛЕ проверки
      // возраста: протухший за сутки контейнер закрыть надо в любом случае.
      const lastSeenMs = (row.lastCheckedAt ?? row.createdAt).getTime();
      if (Date.now() - lastSeenMs < INSTAGRAM_CONTAINER_OWNER_STALE_MS) continue;

      const creds = await loadCredentials();
      if (!creds.igToken) {
        // Instagram отвязали, пока контейнер ждал, — не отказ самого контейнера,
        // просто нечем проверить сейчас. Оставляем PENDING, попробуем в следующий тик.
        continue;
      }
      const identity = await instagramTokenIdentity(creds.igToken);
      if (!identity.ok) {
        continue;
      }

      const status = await checkContainerStatus(row.containerId, creds.igToken);
      await prisma.pendingInstagramContainer.update({ where: { id: row.id }, data: { lastCheckedAt: new Date() } });

      if (status.status === "IN_PROGRESS") continue; // ждём следующего тика молча — это ожидаемо, не ошибка

      if (status.status === "ERROR") {
        await prisma.pendingInstagramContainer.update({
          where: { id: row.id },
          data: { status: "REJECTED", resolvedAt: new Date(), error: status.error },
        });
        void logSystemError("meta", `Публикация в Instagram (объект ${row.propertyId}) не удалась: ${status.error}`);
        rejected++;
        continue;
      }

      // FINISHED — публикуем.
      const result = await publishContainer(row.containerId, identity.id, creds.igToken);
      if (!result.ok) {
        await prisma.pendingInstagramContainer.update({
          where: { id: row.id },
          data: { status: "REJECTED", resolvedAt: new Date(), error: result.error },
        });
        void logSystemError("meta", `Публикация в Instagram (объект ${row.propertyId}) не удалась: ${result.error}`);
        rejected++;
        continue;
      }

      if (row.kind === "REEL") {
        await prisma.pendingInstagramContainer.update({
          where: { id: row.id },
          data: { status: "PUBLISHED", resolvedAt: new Date() },
        });
        // Тот же путь, что и обычная успешная публикация (lib/videoHandoff.ts::
        // publishHandoffResult) — publishedChannels/publishedPostIds/instagramUrl,
        // проверка блокеров продажи, выход в AVAILABLE. НЕ вторая копия этого куска.
        const permalink = await fetchInstagramPermalink(result.postId, creds.igToken);
        await applySucceededPublishResults(row.propertyId, [{ channel: "INSTAGRAM", postId: result.postId }], permalink);
      } else {
        // STORY — история не пост в ленте (см. докстринг PropertyStoryPost), сюда
        // попадает только запись самой истории, publishedChannels не трогаем.
        // Статус контейнера и строка истории — одной транзакцией: порознь падение
        // между ними даёт публикацию в Instagram без записи PropertyStoryPost, и
        // для всей логики историй объекта она как будто не публиковалась.
        await prisma.$transaction([
          prisma.pendingInstagramContainer.update({
            where: { id: row.id },
            data: { status: "PUBLISHED", resolvedAt: new Date() },
          }),
          prisma.propertyStoryPost.create({
            data: {
              propertyId: row.propertyId,
              channel: "INSTAGRAM",
              mediaId: result.postId,
              partIndex: row.partIndex ?? 0,
              kind: row.storyKind ?? "VIDEO",
            },
          }),
        ]);
      }
      published++;
    } catch (err) {
      // Отказ одной записи не должен ронять весь проход — следующий тик попробует
      // её снова (status остаётся PENDING, если мы не успели его сменить выше).
      void logSystemError(
        "meta",
        `Дозавершение отложенного контейнера Instagram (объект ${row.propertyId}) упало неожиданно: ${describeError(err)}`
      );
    }
  }

  return { published, rejected, expired, cancelled };
}
