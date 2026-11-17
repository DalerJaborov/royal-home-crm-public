import { prisma } from "../db.js";

/**
 * ЗАПИСЬ ПОМОЩНИЦЫ НЕ ПОВТОРЯЕТСЯ ПРИ ПОВТОРНОЙ ДОСТАВКЕ ХОДА (третье ревью пачки 2, 08.11.2026).
 *
 * Ход помощницы длится до двух минут, а мягкая остановка worker-процесса — меньше. Поллер Telegram
 * не подтверждает апдейт, пока ход не закончен (telegram/poller.ts), — после перезапуска тот же
 * апдейт придёт снова, и модель снова позовёт create_task. Без отметки клиенту завели бы вторую
 * задачу. Ключ — ход (чат + сообщение) + инструмент + клиент: модель при повторе может переписать
 * текст задачи своими словами, а клиент и ход — те же.
 *
 * Хранится в общей таблице отметок доставки (ProcessedMessage, свой канал), уже завершённой —
 * сброс незавершённых при старте её не трогает, ночная уборка через 3 дня убирает.
 */
const CHANNEL = "ASSISTANT_TURN_WRITE";

function keyOf(turnKey: string, tool: string, subject: string): string {
  return `${turnKey}|${tool}|${subject}`.slice(0, 500);
}

/** id записи, уже сделанной этим ходом (прошлой доставкой), или null. */
export async function findTurnWrite(turnKey: string | undefined, tool: string, subject: string): Promise<string | null> {
  if (!turnKey) return null;
  const row = await prisma.processedMessage.findUnique({
    where: { channel_messageId: { channel: CHANNEL, messageId: keyOf(turnKey, tool, subject) } },
    select: { claimedBy: true },
  });
  return row ? (row.claimedBy ?? "") : null;
}

/** Отметить сделанную запись хода. `claimedBy` здесь — id созданной записи, а не процесса. */
export async function recordTurnWrite(turnKey: string | undefined, tool: string, subject: string, resultId: string): Promise<void> {
  if (!turnKey) return;
  await prisma.processedMessage.createMany({
    data: [{ channel: CHANNEL, messageId: keyOf(turnKey, tool, subject), claimedBy: resultId, completedAt: new Date() }],
    skipDuplicates: true,
  });
}
