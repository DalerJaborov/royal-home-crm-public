import { z } from "zod";
import { logSystemError } from "../lib/systemError.js";
import {
  runTranscriptionRetryAttempt,
  TRANSCRIPTION_RETRY_DELAYS_MS,
} from "../lib/telephony/callRecordings.js";
import type { JobHandler } from "./registry.js";

/**
 * Догоняющая расшифровка разговора (чертёж Б3, 27.08.2026). Ставится из
 * callRecordings.ts, когда поставщик отказал на всех кусках записи. Вся логика —
 * в runTranscriptionRetryAttempt (тот же модуль, что и первичный конвейер);
 * здесь только адаптер к контракту очереди.
 *
 * Единственная очередь, которой в in-memory-версии понадобился «досев после
 * рестарта» — теперь задание переживает перезапуск само, костыль удалён.
 */
const schema = z.object({ interactionId: z.string() });

export const transcriptionRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: "transcription-retry",
  schema,
  // Постановка уже отступает на 5 минут (runAt в scheduleTranscriptionRetry);
  // после неудачной попытки N ждём ступень N: 20 минут, час, 2 часа, 3, 3.
  backoff: (attempt) =>
    TRANSCRIPTION_RETRY_DELAYS_MS[attempt] ?? TRANSCRIPTION_RETRY_DELAYS_MS[TRANSCRIPTION_RETRY_DELAYS_MS.length - 1],
  run: (payload) => runTranscriptionRetryAttempt(payload.interactionId),
  /**
   * Срок попытки (E6 / Ф9 глубокой проверки 02.10.2026): скачивание записи до
   * 2 минут (FETCH_BUDGET_MS) и Gemini до 4 минут на кусок (ai/transcribe.ts) по
   * два куска разом. Лёгкий срок 60 с снимал почти каждую попытку длинного
   * разговора с ожидания: попытка сгорала, а сама расшифровка шла дальше
   * оторванной и наперегонки со следующей. Тип ещё и тяжёлый (jobs/runner.ts) —
   * из очереди расшифровки идут по одной.
   */
  timeoutMs: 10 * 60_000,
  async onGiveUp(payload) {
    // Шесть попыток за ~9,5 часа, и разговор так и остался немым — вот теперь
    // это новость для человека (виден и на экране «Что не доехало» с кнопкой
    // «Повторить», lib/stuckWork.ts). Отдельные отказы поставщика уже записаны внутри
    // transcribeAudioResult; здесь важен итог. Запись на станции цела (живёт
    // год) — расшифровать можно руками тем же путём.
    await logSystemError(
      "ai",
      `Разговор ${payload.interactionId} так и не расшифрован после всех попыток — запись на станции цела, можно повторить вручную`
    );
  },
};
