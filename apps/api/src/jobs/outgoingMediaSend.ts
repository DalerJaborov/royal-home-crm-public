import { z } from "zod";
import { giveUpOutgoingMediaJob, OUTGOING_MEDIA_JOB_TYPE, runOutgoingMediaJob } from "../lib/outgoingMediaJobs.js";
import { backgroundJobsStopSignal } from "./stopSignal.js";
import type { JobHandler } from "./registry.js";

/**
 * Фото/видео сотрудника клиенту: подготовка под канал и отправка (25.11.2026,
 * lib/outgoingMediaJobs.ts). Своя полоса очереди (runner.ts, CUSTOMER_JOB_LANES.media):
 * тик каждые 5 секунд и одно сжатие за раз.
 *
 * Повторы очереди нужны только на один случай — выкат посреди сжатия: обработчик
 * обрывает ffmpeg, бросает, и задание через пару секунд берёт новый процесс. Все прочие
 * исходы (успех, отказ канала, битый файл) обработчик записывает сам и не бросает:
 * повтор после неизвестного исхода отправки задвоил бы видео у клиента.
 */
const schema = z.object({ mediaJobId: z.string().uuid() });
type Payload = z.infer<typeof schema>;

export const outgoingMediaSendJob: JobHandler<Payload> = {
  type: OUTGOING_MEDIA_JOB_TYPE,
  schema,
  backoff: () => 2_000,
  // Ниже «зависшего RUNNING» (15 минут, runner.ts): иначе очередь подобрала бы живое сжатие второй раз.
  timeoutMs: 14 * 60_000,
  async run(payload) {
    await runOutgoingMediaJob(payload.mediaJobId, backgroundJobsStopSignal);
  },
  async onGiveUp(payload) {
    await giveUpOutgoingMediaJob(payload.mediaJobId);
  },
};
