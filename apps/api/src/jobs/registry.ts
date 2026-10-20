import type { z } from "zod";

/**
 * РЕЕСТР ОБРАБОТЧИКОВ ОЧЕРЕДИ (чертёж каркаса §2.2, 26.08.2026).
 *
 * type задания → как его валидировать, исполнять и что делать при провале.
 * Новый джоб = новый файл рядом + строка в handlers.ts; правило чертежа №5:
 * фоновая работа дольше минуты — только через очередь, новые setTimeout-очереди
 * в памяти не проходят ревью.
 *
 * Реестр НАМЕРЕННО не импортирует сами обработчики: их регистрирует handlers.ts,
 * который тянет только worker-процесс (runner). HTTP-процесс ставит задания
 * через jobs/enqueue.ts, не зная обработчиков вовсе, — иначе обработчик
 * ai-reply-retry затягивал бы messengers/* в цепочку импортов enqueue и
 * закольцовывал её (conversation → enqueue → registry → aiReplyRetry →
 * stuckConversations → conversation).
 */
export interface JobHandler<T> {
  type: string;
  /** payload писала прошлая версия кода, читает будущая — это внешние данные. */
  schema: z.ZodType<T>;
  /** Мс до следующей попытки; лесенку задаёт обработчик, не очередь. */
  backoff(attempt: number): number;
  /**
   * Сколько ждать одну попытку, прежде чем снять её с ожидания (по умолчанию —
   * общий срок лёгких/тяжёлых заданий в runner.ts). Задаётся тем, чья попытка
   * законно дольше минуты: ход бота — это окно модели до 75 с плюс подготовка,
   * и снятая «по таймауту» попытка продолжала работать и отвечала клиенту
   * одновременно со следующей (аудит 23.09.2026 №24).
   */
  timeoutMs?: number;
  /** ОБЯЗАН быть идемпотентным: воркер может исполнить дважды (падение между run и DONE). */
  run(payload: T): Promise<void>;
  /** Попытки исчерпаны: видимость для персонала, клиенту — ничего. */
  onGiveUp(payload: T): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- реестр гетерогенный, типобезопасность внутри каждого обработчика
const handlers = new Map<string, JobHandler<any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerJobHandler(handler: JobHandler<any>): void {
  if (handlers.has(handler.type)) {
    throw new Error(`registerJobHandler: тип "${handler.type}" уже зарегистрирован`);
  }
  handlers.set(handler.type, handler);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jobHandlerOf(type: string): JobHandler<any> | undefined {
  return handlers.get(type);
}
