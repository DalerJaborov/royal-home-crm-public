import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import {
  cancelScheduledPhotoPosts,
  closeStuckScheduledPhotoPosts,
  isPhotoPostSetupError,
  publishPropertyPhotoPost,
  PHOTO_POST_PUBLISH_JOB_TYPE,
} from "../lib/photoPosts.js";
import type { JobHandler } from "./registry.js";

/**
 * ПУБЛИКАЦИЯ ФОТО-ПОСТА — ФОНОВЫМ ЗАДАНИЕМ (28.09.2026), по образцу
 * jobs/videoHandoffPublish.ts: `schedulePhotoPostsTick` (lib/photoPosts.ts)
 * уже выдала слот и создала три записи PropertyPhotoPost со status SCHEDULED —
 * здесь только сама публикация, вся логика в publishPropertyPhotoPost.
 *
 * `force: true` — слот и решение публиковать уже приняты на этапе расстановки
 * (photoPostsEnabled проверен там); повторная проверка гейта здесь оставила бы
 * три SCHEDULED-записи висеть без исхода, если рубильник выключили посреди
 * ожидания слота — то же самое место в очереди, только без ролика, которое
 * ждёт и живёт часами.
 */
const schema = z.object({ propertyId: z.string() });

const CHANNEL_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", TELEGRAM: "Telegram" };
type Payload = z.infer<typeof schema>;

export const photoPostPublishJob: JobHandler<Payload> = {
  type: PHOTO_POST_PUBLISH_JOB_TYPE,
  schema,
  // Тот же профиль отказа, что у видео: сеть до соцсетей, может отойти сама.
  backoff: (attempt) => Math.min(2 ** attempt, 8) * 60_000,

  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: { id: true, deletedAt: true, status: true },
    });
    if (!property || property.deletedAt) return; // объект удалили, пока слот ждал своего часа
    // Продан или снят, пока слот ждал, — публиковать нечего; ждущие слоты гасит
    // сама publishPropertyPhotoPost, здесь просто тихо выходим без записи об ошибке.
    if (property.status !== "AVAILABLE") {
      await cancelScheduledPhotoPosts(property.id);
      return;
    }

    const summary = await publishPropertyPhotoPost(payload.propertyId, { force: true });
    // Отказы отдельных каналов publishPropertyPhotoPost уже пишет в журнал сама
    // (префикс «Фото-пост в …») — здесь только случай, когда публикация не
    // запустилась вовсе (объект получил ролик, пока фото-пост ждал слота, и т.п.).
    if (!summary.ok && summary.reason) {
      // Строки SCHEDULED этого объекта больше никто не опубликует — закрываем
      // с причиной (Ф5 аудита фона 02.10.2026), иначе они висели навсегда.
      await closeStuckScheduledPhotoPosts(payload.propertyId, summary.reason);
      void logSystemError("meta", `Фото-пост объекта ${payload.propertyId} не запущен: ${summary.reason}`, {
        dedupKey: "Фото-пост объекта не запущен",
      });
      return;
    }

    /**
     * ПОВТОР УПАВШЕГО КАНАЛА (Ф5 аудита фона 02.10.2026). publishPropertyPhotoPost
     * ловит отказы каналов сама и не бросает — задание становилось DONE, и
     * лестница повторов была недостижима: Instagram, ответивший 500 или ещё
     * обрабатывающий карусель, оставался FAILED навсегда, если хоть один другой
     * канал вышел. Теперь отказ, который повтор может исправить, уводит задание
     * в повтор; вышедшие каналы повтор не трогает (PUBLISHED пропускаются).
     */
    const retryable = Object.entries(summary.results)
      .filter(([, r]) => r && !r.ok && !isPhotoPostSetupError(r.error))
      .map(([channel, r]) => `${CHANNEL_LABEL[channel] ?? channel}: ${r?.error ?? "контейнер ещё обрабатывается"}`);
    if (retryable.length > 0) {
      throw new Error(`Фото-пост: не вышли каналы — ${retryable.join("; ")}`);
    }
  },

  /**
   * Сюда попадают только структурные отказы (БД недоступна и т.п.) —
   * publishPropertyPhotoPost сама ловит отказы каналов и не бросает исключение.
   * Общий путь (jobs/runner.ts) уже пишет logSystemError("background-jobs", ...)
   * и уведомляет хозяина объекта (lib/stuckWork.ts, case "photo-post-publish") —
   * здесь, в отличие от видео-конвейера, нет своей очереди монтажа, которую
   * нужно было бы освобождать, дописывать нечего.
   */
  async onGiveUp(payload) {
    await closeStuckScheduledPhotoPosts(payload.propertyId, "не опубликовано после всех попыток");
  },
};
