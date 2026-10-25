/**
 * Автозакрытие «зависших» подсказок на Главной (18.08.2026).
 *
 * Подсказки «Мой фокус» / «Далее по приоритету» — это открытые Interaction с
 * nextAction != null && completedAt == null (см. routes/dashboard.ts). До сих пор
 * единственным местом, где completedAt проставлялся, была ручная кнопка
 * «Отметить выполненной» (routes/interactions.ts PATCH /:id/complete) — если
 * агент вместо этого просто перезвонил клиенту, ответил ему в переписке или
 * провёл показ, старая подсказка так и висела на Главной, будто ничего не
 * произошло.
 *
 * Это НЕ то же самое, что серия недозвонов в lib/noAnswerStreak.ts — та считает
 * подряд идущие NO_ANSWER и решает, продолжать ли цепочку или эскалировать
 * руководителю; её логику эта функция не трогает и не дублирует. Здесь другая
 * задача: любое НОВОЕ реальное взаимодействие с клиентом закрывает ЕГО СТАРЫЕ
 * открытые подсказки, независимо от того, что там было написано.
 */

import { prisma } from "../db.js";

/**
 * Закрыть все открытые (nextAction != null, completedAt == null) подсказки
 * клиента, КРОМЕ той, что могла быть заведена этим же событием.
 *
 * `excludeInteractionId` обязателен там, где событие само создаёт новую
 * подсказку (новый недозвон, новый показ) — иначе свежесозданная запись гасила
 * бы сама себя в той же операции.
 *
 * Не бросает: вызывающий код — обработчики звонков/сообщений, где сама
 * доставка/запись важнее этой уборки, и она не должна их ронять. Отказ уходит
 * вызывающему как false, чтобы тот при желании записал его в лог сам (as эти
 * места и так оборачивают дополнительные шаги в `.catch`).
 */
export async function closeStaleNextActions(
  clientId: string | null | undefined,
  excludeInteractionId?: string | null,
  now: Date = new Date()
): Promise<number> {
  if (!clientId) return 0;
  const result = await prisma.interaction.updateMany({
    where: {
      clientId,
      nextAction: { not: null },
      completedAt: null, taskCancelledAt: null,
      ...(excludeInteractionId ? { id: { not: excludeInteractionId } } : {}),
    },
    data: { completedAt: now },
  });
  return result.count;
}
