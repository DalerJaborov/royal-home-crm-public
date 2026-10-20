import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { VIDEO_HANDOFF_PUBLISH_JOB_TYPE, VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS, videoHandoffPublishDedupeKey } from "./videoHandoff.js";

/**
 * СТОРОЖ НЕДОВЕДЁННЫХ ПУБЛИКАЦИЙ (21.09.2026, случай №114) — ВТОРОЙ, ТОНКИЙ
 * СЛОЙ, а не основная защита.
 *
 * Основная защита — сама очередь фоновых заданий (`jobs/videoHandoffPublish.ts`
 * + `jobs/runner.ts::claimBatch`): рестарт контейнера посреди публикации
 * оставляет задание `RUNNING`, и подбор зависших (порог 15 минут) сам доводит
 * его до конца. Этот модуль ловит УЗКИЙ остаточный случай — когда самого
 * задания не появилось вовсе: `receiveEditedVideo` записала
 * `videoHandoffStatus=RECEIVED`, но процесс умер РАНЬШЕ следующей строки
 * (постановка в очередь) или сама постановка вернула ошибку (см.
 * `enqueueBackgroundJob`, best-effort по контракту).
 *
 * ВРЕМЯ ПУБЛИКАЦИИ сторож тоже не выбирает сам — берёт уже записанное
 * `Property.scheduledPublishAt` (см. lib/publishSchedule.ts).
 *
 * НИКАКОЙ ВТОРОЙ КОПИИ ЛОГИКИ ПУБЛИКАЦИИ ЗДЕСЬ НЕТ — сторож только СТАВИТ то
 * же самое задание (`videoHandoffPublishDedupeKey`), которое ставит обычный
 * приём ролика; всю работу (обложка, пять сетей, запись каналов, выход в
 * продажу, автоподбор, уведомление) делает `jobs/videoHandoffPublish.ts`.
 *
 * УСЛОВИЯ ОТБОРА:
 *  - videoHandoffStatus=RECEIVED, файл на диске есть (videoHandoffFinalPath),
 *    publishedChannels пуст (ничего не ушло вовсе — частичный успех сторож не
 *    трогает: там уже есть с чем работать вручную через карточку, и повторный
 *    проход в частично опубликованный объект не входит в узкий случай, который
 *    этот модуль закрывает);
 *  - videoHandoffReceivedAt НЕ ПУСТ И СТАРШЕ ПОРОГА. Поле появилось вместе с
 *    этим сторожем (миграция 20260921120000) — у объектов, принятых ДО него,
 *    оно всегда NULL, и фильтр `not: null` защищает от случайного массового
 *    перезапуска старых, уже разобранных вручную объектов в день выката.
 *    Порог — 10 минут: постановка задания в receiveEditedVideo происходит
 *    практически мгновенно (следующая строка кода после записи RECEIVED), то
 *    есть отсутствие задания дольше нескольких секунд уже подозрительно;
 *    десять минут — щедрый запас на случай нагрузки/пересборки соединения с
 *    базой между двумя запросами, без гонки с самим обычным путём;
 *  - НЕТ ЗАПИСИ BackgroundJob ЭТОГО КРУГА (ждущей, исполняющейся или
 *    законченной после приёма текущего ролика; строка прошлого круга монтажа
 *    не в счёт — №192 ночной проверки 24.09). Если запись есть — она либо ждёт/исполняется (обычный путь уже
 *    сработал, трогать нечего), либо уже дошла до DONE/GIVEN_UP: DONE не
 *    может стоять рядом с пустым publishedChannels при успешной попытке
 *    (`publishHandoffResult` пишет каналы ДО возврата), а GIVEN_UP — это уже
 *    ЧЕСТНЫЙ провал с уведомлением администратору (см. onGiveUp в
 *    jobs/videoHandoffPublish.ts) — сторож не обязан и не должен превращать
 *    исчерпанные попытки в бесконечный автоматический повтор без участия
 *    человека.
 */
const STALE_MINUTES = 10;
const STALE_MS = STALE_MINUTES * 60 * 1000;

export async function runVideoHandoffUnfinishedPublishWatchdogTick(now: Date = new Date()): Promise<{ recovered: number }> {
  const cutoff = new Date(now.getTime() - STALE_MS);
  const stuck = await prisma.property.findMany({
    where: {
      videoHandoffStatus: "RECEIVED",
      deletedAt: null,
      videoHandoffFinalPath: { not: null },
      videoHandoffReceivedAt: { not: null, lt: cutoff },
      publishedChannels: { isEmpty: true },
      // Ролик ждёт проверки модератора (25.09.2026, lib/clipReview.ts) — задания
      // нет намеренно, его поставит «Одобрить». Иначе сторож выпускал бы
      // непроверенный ролик в сети через 10 минут после приёма.
      clipReviewStatus: { not: "PENDING" },
    },
    select: { id: true, shortId: true, scheduledPublishAt: true, videoHandoffReceivedAt: true },
    // Предел выборки (22.09.2026, тот же класс, что #690): тик повторяется,
    // остаток разберётся следующим проходом.
    take: 200,
  });
  if (stuck.length === 0) return { recovered: 0 };

  let recovered = 0;
  for (const property of stuck) {
    // Задание ЭТОГО круга: ждёт/исполняется, либо закончилось уже после приёма
    // текущего ролика (№192 ночной проверки 24.09). Строка прошлого круга —
    // DONE/GIVEN_UP, обновлённая ДО videoHandoffReceivedAt, — следом не
    // считается: раньше она навсегда закрывала сторожу объект, у которого
    // монтаж прошёл второй раз, а постановка нового задания сорвалась.
    const existingJob = await prisma.backgroundJob.findFirst({
      where: {
        type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
        payload: { path: ["propertyId"], equals: property.id },
        OR: [
          { status: { in: ["PENDING", "RUNNING"] } },
          // receivedAt отобран «not null» в выборке выше; запасное значение — для типов.
          { updatedAt: { gte: property.videoHandoffReceivedAt ?? new Date(0) } },
        ],
      },
      select: { id: true },
    });
    if (existingJob) continue; // уже есть след этого круга — ждёт, исполняется или уже честно разобрано (см. докстринг выше)

    const enqueued = await enqueueBackgroundJob({
      type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
      payload: { propertyId: property.id },
      maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
      dedupeKey: videoHandoffPublishDedupeKey(property.id),
      // ТОТ ЖЕ СЛОТ, ЧТО ВЫБРАЛ ОБЫЧНЫЙ ПРИЁМ. `scheduledPublishAt` пишется в
      // ту же запись, что и статус RECEIVED, то есть ДО постановки задания —
      // ровно в том разрыве, который этот сторож и закрывает, время уже
      // выбрано. Не взять его значило бы выложить ролик мимо расписания
      // (см. lib/publishSchedule.ts), а сторожу это решать не положено.
      // Слот в прошлом — задание уедет ближайшим тиком, как и должно.
      ...(property.scheduledPublishAt ? { runAt: property.scheduledPublishAt } : {}),
    });
    if (!enqueued.enqueued) continue; // повторим на следующем тике — та же best-effort постановка, что и в receiveEditedVideo

    // ГЛАВНОЕ ТРЕБОВАНИЕ ЗАДАНИЯ: сам факт «нашли недоведённую публикацию и
    // доделали» обязан быть виден, а не проходить незаметно — случай №114
    // прожил ночь именно из-за тишины в журнале.
    await logSystemError(
      "video-handoff",
      `Объект №${property.shortId}: публикация ролика не была поставлена в очередь (или потерялась) — сторож поставил её заново`
    );
    recovered++;
  }
  return { recovered };
}
