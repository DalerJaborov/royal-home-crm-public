import { z } from "zod";

/**
 * СРОК ПАУЗЫ БОТА, КОТОРЫЙ СОТРУДНИК ВЫБРАЛ ПРИ ОТВЕТЕ (владелец 26.11.2026) — ОДНА ДВЕРЬ ВХОДА
 * для текста, голосового и фото/видео. Экран шлёт абсолютное время `pausedUntil` (ISO),
 * сервер проверяет границы одинаково для всех трёх путей, а не каждый маршрут по-своему.
 *
 * Границы: не в прошлом больше чем на 2 минуты (допуск на отстающие часы устройства; иначе «ответ» молча снял бы
 * паузу) и не дальше «бессрочно»
 * (10 лет, OPERATOR_REPLY_PAUSE_MS) с запасом в двое суток на часы устройства.
 */
/** Допуск на часы устройства: срок «сейчас + 10 минут» с часов, отстающих на минуту, не должен давать 400. */
export const REPLY_PAUSE_PAST_TOLERANCE_MS = 2 * 60_000;
export const REPLY_PAUSE_MAX_AHEAD_MS = 10 * 365 * 24 * 3_600_000 + 2 * 24 * 3_600_000;

/** Срок — необязательное поле: нет его — действует прежнее умолчание сервера для отправителя. */
export const replyPausedUntilField = z
  .string()
  .datetime()
  .optional()
  .refine((value) => !value || Date.parse(value) >= Date.now() - REPLY_PAUSE_PAST_TOLERANCE_MS, { message: "Срок паузы уже прошёл" })
  .refine((value) => !value || Date.parse(value) <= Date.now() + REPLY_PAUSE_MAX_AHEAD_MS, { message: "Срок паузы слишком далёкий" });

/** Срок в минутах от сейчас (не меньше одной): строка задания очереди хранит длительность, а не дату. */
export function pauseMinutesUntil(until: Date, now = Date.now()): number {
  return Math.max(1, Math.round((until.getTime() - now) / 60_000));
}
