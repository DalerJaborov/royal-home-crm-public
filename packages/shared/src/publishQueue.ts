import { z } from "zod";

/**
 * ОЧЕРЕДЬ ПУБЛИКАЦИЙ — РУЧНОЕ ВРЕМЯ ВЫХОДА (24.09.2026, владелец: «хочу нажать
 * из очереди кнопку, чтобы этот пост пошёл сейчас», и вообще управлять очередью
 * кнопками, а не только ждать часа по тепловой карте).
 *
 * Здесь — договор между экраном «Маркетинг → Расписание» и
 * `POST /properties/:id/publish-at`: одна схема, один предел, один перевод
 * «часы Душанбе → момент времени». Экран и сервер держат одно правило.
 */

/** Дальше месяца вперёд переносить незачем: это уже не очередь, а забытый ролик. */
export const PUBLISH_AT_MAX_DAYS = 30;

export const publishAtSchema = z.object({
  /** Момент выхода, ISO со смещением («2026-09-24T19:30:00+05:00»). */
  at: z.string().datetime({ offset: true }),
});

export type PublishAtInput = z.infer<typeof publishAtSchema>;

/**
 * «2026-09-24T19:30» из поля ввода даты и времени — это часы ДУШАНБЕ, а не
 * пояс браузера: владелец может открыть CRM с телефона в поездке, и ролик,
 * перенесённый «на 19:30», обязан выйти в 19:30 по Душанбе. Душанбе круглый
 * год UTC+5, переходов на летнее время нет.
 * Неверная строка — `null`.
 */
export function dushanbeLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+05:00`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** Обратно: момент времени → значение поля ввода в часах Душанбе. */
export function isoToDushanbeLocal(iso: string | Date): string {
  const shifted = new Date(new Date(iso).getTime() + 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}
