import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { isPhotoPostSetupError } from "../lib/photoPosts.js";
import { closeStuckScheduledReposts, publishPropertyRepost, SOCIAL_REPOST_PUBLISH_JOB_TYPE } from "../lib/socialReposts.js";
import type { JobHandler } from "./registry.js";

/**
 * ПУБЛИКАЦИЯ ПОВТОРА — ФОНОВЫМ ЗАДАНИЕМ (28.09.2026, agent-brief.md
 * reposts-digests), по образцу jobs/photoPostPublish.ts: `scheduleRepostsTick`
 * (lib/socialReposts.ts) уже выдала слот и создала три записи
 * PropertySocialRepost со status SCHEDULED — здесь только сама публикация.
 *
 * `force: true` — слот и решение публиковать уже приняты на этапе
 * расстановки (repostsEnabled проверен там); повторная проверка гейта здесь
 * оставила бы три SCHEDULED-записи висеть без исхода, если рубильник
 * выключили посреди ожидания слота.
 */
const schema = z.object({ propertyId: z.string(), round: z.number().int().min(1) });

const CHANNEL_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", TELEGRAM: "Telegram" };
type Payload = z.infer<typeof schema>;

export const socialRepostPublishJob: JobHandler<Payload> = {
  type: SOCIAL_REPOST_PUBLISH_JOB_TYPE,
  schema,
  // Тот же профиль отказа, что у фото-постов: сеть до соцсетей, может отойти сама.
  backoff: (attempt) => Math.min(2 ** attempt, 8) * 60_000,

  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: { id: true, deletedAt: true },
    });
    if (!property || property.deletedAt) return; // объект удалили, пока слот ждал своего часа

    const summary = await publishPropertyRepost(payload.propertyId, payload.round, { force: true });
    if (!summary.ok && summary.reason) {
      // Строки SCHEDULED этого круга больше никто не опубликует — закрываем с
      // причиной (класс Ф5 аудита фона 02.10.2026), иначе объект навсегда
      // выпадал из расстановки, а в карточке висело «запланировано».
      await closeStuckScheduledReposts(payload.propertyId, payload.round, summary.reason);
      void logSystemError("meta", `Повтор объекта ${payload.propertyId} (круг ${payload.round}) не запущен: ${summary.reason}`, {
        dedupKey: "Повтор объекта не запущен",
      });
      return;
    }

    /**
     * ПОВТОР УПАВШЕГО КАНАЛА (аудит 04.10.2026, PUB04). publishPropertyRepost ловит
     * отказы каналов сама и не бросает: при упавшем Instagram и вышедшем Telegram (и
     * даже при всех упавших) задание становилось DONE, лестница maxAttempts/backoff
     * недостижима, а следующий круг считается по max(round) среди PUBLISHED и
     * упавший канал старого круга уже не повторял. Тот же приём, что у
     * jobs/photoPostPublish.ts: отказ, который повтор может исправить, уводит
     * задание в повтор; вышедшие каналы повтор пропускает (PUBLISHED), FAILED-строки
     * того же круга переиспользуются. Структурные отказы (канал не подключён, нет
     * CRM_PUBLIC_URL) терминальны.
     */
    const retryable = Object.entries(summary.results)
      .filter(([, r]) => r && !r.ok && !isPhotoPostSetupError(r.error))
      .map(([channel, r]) => `${CHANNEL_LABEL[channel] ?? channel}: ${r?.error ?? "контейнер ещё обрабатывается"}`);
    if (retryable.length > 0) {
      throw new Error(`Повтор: не вышли каналы — ${retryable.join("; ")}`);
    }
  },

  /**
   * Сюда попадают структурные отказы и исчерпанные попытки повтора упавшего
   * канала — publishPropertyRepost сама ловит отказы каналов и не бросает
   * исключение (бросает run выше). Общий путь (jobs/runner.ts)
   * уже пишет logSystemError и уведомляет хозяина объекта (lib/stuckWork.ts,
   * case "social-repost-publish").
   */
  async onGiveUp(payload) {
    await closeStuckScheduledReposts(payload.propertyId, payload.round, "не опубликовано после всех попыток");
  },
};
