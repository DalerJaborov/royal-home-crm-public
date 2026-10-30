import { promises as fs } from "node:fs";
import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import {
  VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
  publishHandoffResult,
  videoHandoffFinalDiskPath,
  releaseQueueIfClear,
  notifyVideoHandoffPublishResult,
  HANDOFF_PUBLISHABLE_STATUSES,
  handoffSkippedByStatusReason,
  blockDuplicateFinalBeforePublish,
} from "../lib/videoHandoff.js";
import { replaceOldPostsBeforeRemakePublish } from "../lib/publishedVideoFix.js";
import type { JobHandler } from "./registry.js";

/**
 * ПУБЛИКАЦИЯ ПРИНЯТОГО ОТ МОНТАЖЁРА РОЛИКА — ФОНОВЫМ ЗАДАНИЕМ (21.09.2026,
 * случай №114: объект №114, ролик принят, файл на диске, но рестарт
 * контейнеров api/worker посреди публикации оборвал её молча — ни одного
 * исключения, значит и `logSystemError` не сработал; `videoHandoffStatus`
 * остался RECEIVED, `publishedChannels` пуст, объект завис в EDITING навсегда,
 * пока владелец не заметил сам и не опубликовал руками).
 *
 * Раньше `lib/videoHandoff.ts::receiveEditedVideo` делала всю эту работу
 * (кадр обложки, пять сетей, минуты) СИНХРОННО в том же вызове — и в
 * телеграм-вебхуке (routes/webhooks.ts), который отвечает Telegram `200 OK`
 * ДО обработки апдейта. Апдейт с готовым роликом уже считался «обработанным»
 * (`isDuplicateDelivery` ставит отметку до работы, не после), и вторая
 * доставка от Telegram была невозможна — работу было некому повторить.
 *
 * ТЕПЕРЬ публикация — задание в `BackgroundJob` (dedupeKey на объект):
 * рестарт посреди исполнения оставляет задание `RUNNING`, и подбор зависших
 * (`jobs/runner.ts::claimBatch`, порог 15 минут) сам доводит его до конца или
 * до честной сдачи (`onGiveUp`) — систематически, для КАЖДОГО такого сбоя, а
 * не только для уже случившегося. `videoHandoffUnfinishedPublishWatchdog.ts`
 * — тонкая страховка НА СЛУЧАЙ, если само задание не успело встать в очередь
 * (процесс умер между записью статуса RECEIVED и постановкой, соседние
 * строки в receiveEditedVideo).
 *
 * ВСЯ ЛОГИКА ПУБЛИКАЦИИ — В `publishHandoffResult` (lib/videoHandoff.ts), это
 * лишь адаптер к контракту очереди, копии логики здесь нет и не будет.
 */
const schema = z.object({ propertyId: z.string() });
type Payload = z.infer<typeof schema>;

/**
 * В КАКИХ СОСТОЯНИЯХ ОБЪЕКТА РОЛИК ЕЩЁ УМЕСТНО ПУБЛИКОВАТЬ (24.09.2026, ночная
 * проверка). Задание ждёт своего слота часами (расстановка публикаций по
 * времени), и за это время агент может снять объект с продажи (WITHDRAWN),
 * продать (SOLD) или забронировать (RESERVED). Раньше задание смотрело только
 * `deletedAt`/`videoHandoffStatus`/файл — и снятый объект уходил в пять сетей,
 * а `finalizePropertyAvailability` возвращал его в «В продаже» и на сайт.
 * Ни один путь смены статуса задание не гасит (crud.ts при WITHDRAWN только
 * снимает объявление с сайта), поэтому проверка стоит здесь, на входе.
 * Уместно: конвейер подготовки (в норме — EDITING) и AVAILABLE (объект уже
 * вывели в продажу руками, ролик ему всё ещё нужен). Список живёт в
 * lib/videoHandoff.ts — тот же пропуск видят приём файла и «Опубликовать сейчас».
 */
const PUBLISHABLE_STATUSES = HANDOFF_PUBLISHABLE_STATUSES;

export const videoHandoffPublishJob: JobHandler<Payload> = {
  type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
  schema,
  // Отказ здесь — почти всегда сеть до соцсетей, которая может отойти сама:
  // 2м → 4м → 8м → 8м → 8м → 8м (maxAttempts=6 задан в receiveEditedVideo,
  // «задаёт вызывающий, а не реестр обработчиков», см. registry.ts).
  backoff: (attempt) => Math.min(2 ** attempt, 8) * 60_000,

  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: { id: true, shortId: true, deletedAt: true, status: true, videoHandoffStatus: true, videoHandoffFinalPath: true, clipReviewStatus: true },
    });
    if (!property || property.deletedAt) return; // объект удалили, пока задание ждало своей очереди — публиковать нечего
    // Ролик ждёт проверки модератора (25.09.2026, lib/clipReview.ts) — последний
    // рубеж: какое бы задание ни дожило до этой минуты (поставленное до включения
    // проверки, руками, сторожем), непроверенный ролик в сети не уходит.
    // «Одобрить» поставит задание заново тем же ключом.
    if (property.clipReviewStatus === "PENDING") return;
    if (property.videoHandoffStatus !== "RECEIVED" || !property.videoHandoffFinalPath) {
      // Статус сдвинули руками между постановкой и исполнением — пересылка
      // после ошибки (reopenForResend) или отмена/пропуск (skipVideoHandoffOnManualPublish,
      // cancelVideoHandoffQueueEntry). Более свежий вызов receiveEditedVideo уже
      // поставил СВОЁ задание с тем же dedupeKey — публиковать по устаревшему
      // payload означало бы рисковать задвоить пост. Это ожидаемая гонка, не
      // поломка — logSystemError не пишем.
      return;
    }
    if (!PUBLISHABLE_STATUSES.includes(property.status)) {
      // Объект сняли с продажи / продали / забронировали, пока ролик ждал
      // слота (24.09.2026, ночная проверка). Публиковать его в сети и возвращать
      // в «В продаже» нельзя; статус объекта и принятый ролик не трогаем —
      // если объект вернут в продажу, ролик опубликуют руками. В журнал пишем,
      // чтобы принятый, но не ушедший ролик не потерялся молча; пуш
      // «не удалось проверить» (summary=null) сюда не годится — это не сбой.
      void logSystemError(
        "video-handoff",
        `Объект ${property.id}: ролик принят, но публикация пропущена — объект в статусе ${property.status}, а не в подготовке/продаже`, { dedupKey: "Объект …: ролик принят, но публикация пропущена — объект в статусе …, а не в подготовке/продаже" }
      );
      // Причина — на объект (25.09.2026, раздел 6 спецификации монтажа): карточка
      // и «Расписание» показывают scheduledPublishReason рядом с часом, и без
      // этой строки прошедший слот молча висел без объяснения, почему не вышло.
      await prisma.property.update({
        where: { id: property.id },
        data: { scheduledPublishReason: handoffSkippedByStatusReason(property.status) },
      });
      await releaseQueueIfClear(property.id);
      return;
    }

    const diskPath = videoHandoffFinalDiskPath(property.videoHandoffFinalPath);
    if (!diskPath || !(await fileExists(diskPath))) {
      // Честная запись в журнал вместо падения посреди publishApprovedPost
      // (там часть каналов читает файл напрямую, часть — по URL; на
      // отсутствующем файле поведение канал от канала отличалось бы). Ролик
      // числится принятым, но публиковать нечего — нужен человек.
      void logSystemError(
        "video-handoff",
        `Объект ${property.id}: задание публикации запущено, но файла ролика на диске нет (${property.videoHandoffFinalPath})`, { dedupKey: "Объект …: задание публикации запущено, но файла ролика на диске нет (…)" }
      );
      await notifyVideoHandoffPublishResult(property.id, null);
      await releaseQueueIfClear(property.id);
      return;
    }

    // Тот же файл, что уже принят готовым роликом другого объекта (25.09.2026, А4:
    // «один и тот же ролик у двух квартир») — не публикуем; журнал, пуш маркетингу
    // и причина на объекте — внутри. Место монтажёра к этому моменту уже свободно.
    if (await blockDuplicateFinalBeforePublish(property.id, property.shortId, diskPath)) {
      await releaseQueueIfClear(property.id);
      return;
    }

    // Перемонтаж по новой цене/данным: старые посты уходят сейчас, перед выходом нового
    // ролика (владелец 30.10.2026), а не при возврате монтажёру. Сбой снятия публикацию
    // не останавливает — занятый канал она просто пропустит, причина уже в журнале.
    await replaceOldPostsBeforeRemakePublish(property.id).catch((err) =>
      logSystemError("meta", `Объект ${property.id}: замена старых постов перед публикацией перемонтажа не удалась: ${err instanceof Error ? err.message : String(err)}`)
    );
    const summary = await publishHandoffResult(property.id, property.videoHandoffFinalPath);
    await notifyVideoHandoffPublishResult(property.id, summary);
    // Подстраховка, не основной путь (21.09.2026, расстановка публикаций по
    // времени): место монтажёра `receiveEditedVideo` освобождает уже в момент
    // приёма файла, этот вызов — на случай задания, поставленного до той
    // правки. releaseQueueIfClear идемпотентна, повторный вызов безопасен.
    await releaseQueueIfClear(property.id);
  },

  /**
   * Сюда попадают только структурные отказы (БД недоступна, процесс гибнет раз
   * за разом на этом задании) — publishHandoffResult сама ловит отказы
   * отдельных каналов и не бросает исключение на них, значит run() уходит в
   * DONE даже при полном провале публикации (см. notifyVideoHandoffPublishResult
   * там же — это её случай, не этот).
   *
   * УВЕДОМЛЕНИЕ И ЖУРНАЛ ЗДЕСЬ НЕ ДУБЛИРУЕМ (после слияния с PR #627
   * «Что не доехало», 21.09.2026 — тот же случай №114 с другой стороны):
   * `jobs/runner.ts` уже пишет `logSystemError("background-jobs", ...)` и зовёт
   * `notifyStuckWorkGivenUp` для ЛЮБОГО GIVEN_UP до вызова этого хука —
   * директора и хозяин объекта (см. `describeJob` в lib/stuckWork.ts, кейс
   * "video-handoff-publish" добавлен туда же) уже узнали. Дописывать здесь
   * вторую строку в журнал и второй пуш о том же самом провале значило бы
   * нарушить «одно событие — одно уведомление» (решение владельца 20.09.2026).
   * Единственное, чего генерик не знает, — про очередь монтажа.
   */
  async onGiveUp(payload) {
    await releaseQueueIfClear(payload.propertyId);
  },
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
