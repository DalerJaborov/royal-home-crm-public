import { z } from "zod";
import type { JobHandler } from "./registry.js";
import { SOCIAL_VIDEO_PUBLISH_JOB_TYPE, runSocialVideoPublish } from "../lib/socialVideoPosts.js";

/**
 * ПУБЛИКАЦИЯ СВОБОДНОГО РОЛИКА В СОЦСЕТИ (12.10.2026).
 *
 * Вся логика — в lib/socialVideoPosts.ts::runSocialVideoPublish; здесь только
 * оболочка очереди. Заход идёт минуты (Instagram ждёт обработку ролика до пяти минут,
 * TikTok грузит кусками, каналы идут по очереди), поэтому в HTTP-запросе это не живёт и
 * переживает рестарт контейнера.
 *
 * ТАЙМАУТ 9 МИНУТ: тип «тяжёлый» (один за тик, в хвосте партии, runner.ts), а потолок тика
 * очереди — 20 минут: девять лёгких заданий по минуте плюс это задание должны в него
 * укладываться; к тому же очередь подбирает зависшее RUNNING через 15 (STUCK_RUNNING_MIN).
 * Если заход всё же длиннее, очередь снимает его с ожидания, а сам он продолжает жить в этом
 * процессе — повторный заход видит `inFlight` и тихо выходит, ничего не публикуя вторично.
 *
 * Упавший канал автоматически НЕ повторяется: ошибка записана в ролике, человек решает
 * («Повторить» — кнопка на экране). Повтор задания очередью (maxAttempts 2) нужен только
 * на случай гибели процесса посреди захода — тогда он добирает ещё не тронутые каналы, а канал,
 * на котором процесс оборвался, помечает «проверьте площадку» (не публикует вслепую).
 */
const schema = z.object({ id: z.string().min(1) });

export const socialVideoPublishJob: JobHandler<z.infer<typeof schema>> = {
  type: SOCIAL_VIDEO_PUBLISH_JOB_TYPE,
  schema,
  backoff: () => 60_000,
  timeoutMs: 9 * 60_000,

  async run(payload) {
    await runSocialVideoPublish(payload.id);
  },

  /** Отдельной записи не нужно: runner.ts сам пишет GIVEN_UP в журнал и уведомляет «Что не доехало». */
  async onGiveUp() {},
};
