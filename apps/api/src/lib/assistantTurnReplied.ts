import { prisma } from "../db.js";

/**
 * НА ОДНО СООБЩЕНИЕ — ОДИН ОТВЕТ ПОМОЩНИЦЫ ДАЖЕ ПРИ ПОВТОРНОЙ ДОСТАВКЕ (24.11.2026).
 *
 * Журнал прода: «срыв (stream_interrupted) после находок — отдан частичный ответ», сотрудник получил
 * частичный ответ, а через 27 секунд — полный на то же голосовое. Поллер Telegram не подтверждает
 * апдейт, пока ход не закончен (telegram/poller.ts), а отметку «в работе» после перезапуска или
 * сбоя сбрасывает (lib/webhookDedupe.ts): тот же апдейт приходит снова и ход идёт заново ПОВЕРХ уже
 * отправленного ответа. Записи от такого повтора защищены (lib/assistantTurnWrites.ts), сам ответ — нет.
 *
 * Отметка ставится ПОСЛЕ отправки ответа: упавший до отправки ход повтор по-прежнему отвечает.
 * Хранится в общей таблице отметок (ProcessedMessage, свой канал), уже завершённой: сброс
 * незавершённых при старте её не трогает, ночная уборка через 3 дня убирает.
 */
const CHANNEL = "ASSISTANT_TURN_REPLY";

const keyOf = (turnKey: string): string => turnKey.slice(0, 500);

/** На этот ход (чат + сообщение) ответ уже ушёл — второй раз его не запускаем. */
export async function assistantTurnReplied(turnKey: string | undefined): Promise<boolean> {
  if (!turnKey) return false;
  try {
    const row = await prisma.processedMessage.findUnique({
      where: { channel_messageId: { channel: CHANNEL, messageId: keyOf(turnKey) } },
      select: { id: true },
    });
    return row !== null;
  } catch {
    // Отказ базы — «не дубль»: лучше второй ответ, чем молчание (политика lib/webhookDedupe.ts).
    return false;
  }
}

/** Ответ на ход ушёл. Сбой записи не мешает: хуже — повторный ответ, как раньше. */
export async function markAssistantTurnReplied(turnKey: string | undefined): Promise<void> {
  if (!turnKey) return;
  await prisma.processedMessage
    .createMany({ data: [{ channel: CHANNEL, messageId: keyOf(turnKey), completedAt: new Date() }], skipDuplicates: true })
    .catch((err) => console.error("[telegram:assistant] отметка «ответ ушёл» не записана:", err instanceof Error ? err.message : err));
}
