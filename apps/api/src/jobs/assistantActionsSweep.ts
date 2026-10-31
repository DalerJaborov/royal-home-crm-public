import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * ЧИСТКА ДЕЙСТВИЙ ИИ-ПОМОЩНИКА (П2, задача 2.6; брокер — lib/assistantActions.ts).
 * Зовётся раз в час из cron.ts (`assistant-actions-sweep`). Вынесено сюда, а не
 * написано прямо в cron.ts, потому что у cron.ts нет тестов — функция здесь
 * проверяется `tests/assistant-actions-sweep.test.ts`.
 *
 * Три шага, каждый одним `updateMany`/`deleteMany` с условием — безопасно при
 * гонке с нажатием (брокер сам переводит статусы тем же условным способом):
 * 1. PENDING с истёкшим сроком → EXPIRED (и ключ идемпотентности освобождается).
 *    Брокер гасит такие и сам при нажатии; сборщик нужен для тех, по которым
 *    больше никто не нажмёт, — иначе они висели бы «ждёт подтверждения» вечно.
 * 2. CONFIRMED дольше `STUCK_CONFIRMED_MS` → FAILED. Так бывает, только если
 *    процесс упал посреди исполнения: исполнилось ли действие — неизвестно,
 *    поэтому это не тихая чистка, а строка в журнал ошибок.
 * 3. EXPIRED старше 7 дней удаляются. EXECUTED/UNDONE/FAILED/CANCELLED НЕ
 *    удаляются никогда — это след того, что помощник менял в CRM.
 */
export const STUCK_CONFIRMED_MS = 15 * 60_000;
export const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface AssistantActionsSweepResult {
  expired: number;
  stuckFailed: number;
  deleted: number;
}

export async function runAssistantActionsSweep(now: Date = new Date()): Promise<AssistantActionsSweepResult> {
  const expired = await prisma.assistantAction.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED", idempotencyKey: null },
  });

  const stuck = await prisma.assistantAction.updateMany({
    where: { status: "CONFIRMED", confirmedAt: { lte: new Date(now.getTime() - STUCK_CONFIRMED_MS) } },
    data: {
      status: "FAILED",
      statusReason: "прервано: исполнение не завершилось (перезапуск сервера?)",
      idempotencyKey: null,
    },
  });
  if (stuck.count > 0) {
    await logSystemError(
      "ai",
      `Помощник: ${stuck.count} подтверждённых действий не завершились — проверьте вручную, применились ли они (AssistantAction, statusReason «прервано»)`
    );
  }

  const deleted = await prisma.assistantAction.deleteMany({
    where: { status: "EXPIRED", expiresAt: { lt: new Date(now.getTime() - EXPIRED_RETENTION_MS) } },
  });

  return { expired: expired.count, stuckFailed: stuck.count, deleted: deleted.count };
}
