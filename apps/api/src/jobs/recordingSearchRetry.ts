import { z } from "zod";
import { logSystemError } from "../lib/systemError.js";
import {
  runRecordingSearchRetryAttempt,
  RECORDING_SEARCH_RETRY_DELAYS_MS,
} from "../lib/telephony/callRecordings.js";
import type { JobHandler } from "./registry.js";

/**
 * Догоняющий поиск файла записи (20.09.2026). Ставится из callRecordings.ts,
 * когда звонок был ОТВЕЧЕН, а искать файл на станции (2+6+15с) не хватило —
 * обычно из-за обрыва обратного туннеля (~30с в фактах 20.09.2026). Вся логика
 * поиска и сохранения — в runRecordingSearchRetryAttempt (тот же модуль, что и
 * первичный конвейер); здесь только адаптер к контракту очереди — тем же
 * приёмом, что и transcriptionRetryJob рядом.
 */
const schema = z.object({
  interactionId: z.string(),
  search: z.object({
    startedAt: z.string(),
    agentExtension: z.string().nullable(),
    clientPhone: z.string(),
    answeredAt: z.string().nullable(),
    // Направление звонка — обязательно с 21.09.2026 (см. RecordingSearch в
    // callRecordings.ts): без него findRecording не может отсечь чужую запись
    // соседнего направления по префиксу имени файла.
    direction: z.enum(["incoming", "outgoing"]),
  }),
  durationSec: z.number().nullable(),
});

export const recordingSearchRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: "recording-search-retry",
  schema,
  // Постановка уже отступает на минуту (runAt в scheduleRecordingSearchRetry);
  // после неудачной попытки N ждём следующую ступень: 5 минут, затем 15.
  backoff: (attempt) =>
    RECORDING_SEARCH_RETRY_DELAYS_MS[attempt] ?? RECORDING_SEARCH_RETRY_DELAYS_MS[RECORDING_SEARCH_RETRY_DELAYS_MS.length - 1],
  run: (payload) => runRecordingSearchRetryAttempt(payload),
  /**
   * Срок попытки (E6 / Ф9 глубокой проверки 02.10.2026): поиск по каталогу
   * станции (до ~23 с) и скачивание файла до 2 минут (FETCH_BUDGET_MS). Лёгкий
   * срок 60 с снимал попытку посреди скачивания и сжигал короткую лесенку из
   * трёх попыток, пока файл ещё ехал.
   */
  timeoutMs: 4 * 60_000,
  async onGiveUp(payload) {
    // Три попытки за ~20 минут, разговор состоялся, а записи на станции так и
    // нет. Для недозвона пустой каталог — норма и сюда не долетает вовсе (см.
    // ingestCallRecording: задание ставится только при clientAnswered), поэтому
    // здесь всегда реальная поломка — либо MixMonitor не пишет, либо туннель
    // лежал дольше всей лесенки повторов.
    await logSystemError(
      "telephony",
      `Разговор ${payload.interactionId} был отвечен, но запись так и не нашлась на станции после всех попыток — проверьте MixMonitor и туннель до АТС`
    );
  },
};
