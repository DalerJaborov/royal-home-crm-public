import { prisma, type TxClient } from "../db.js";
import type { Interaction, Prisma } from "../generated/prisma/client.js";
import { closeMeetingReminderPushes } from "./meetingReminders.js";
import { closeStaleNextActions } from "./nextActionAutoClose.js";
import { loadEventPoints, recordScoreEvent, recordScoreEventInTransaction, type ScoreEventKind } from "./scoreJournal.js";

/** У показов, встреч и обычных задач разные события Royal Score. */
function completionEventKind(type: string, overdue: boolean): ScoreEventKind {
  if (type === "SHOWING") return overdue ? "showing_missed" : "showing_done";
  if (type === "MEETING") return overdue ? "meeting_overdue" : "meeting_done";
  return overdue ? "task_overdue" : "task_on_time";
}

/** После фиксации задачи закрываем устаревшие напоминания и, для встречи/показа, подсказки. */
export function afterInteractionTaskCompleted(interaction: Interaction): void {
  if (interaction.type === "SHOWING" || interaction.type === "MEETING") {
    void closeStaleNextActions(interaction.clientId, interaction.id).catch((err) =>
      console.error("[interactions] закрытие старых подсказок:", err instanceof Error ? err.message : err)
    );
  }
  const taskOwnerId = interaction.subjectAgentId ?? interaction.agentId;
  if (taskOwnerId) void closeMeetingReminderPushes(interaction.id, taskOwnerId).catch((err) =>
    console.error("[interactions] закрытие пушей по задаче:", err instanceof Error ? err.message : err)
  );
}

/** Общий переход CRM и помощника. Внешняя транзакция запускает напоминания после commit. */
export async function completeInteractionTask(
  interaction: Interaction,
  expected?: Prisma.InteractionWhereInput,
  tx?: TxClient,
) {
  const db = tx ?? prisma;
  const taskOwnerId = interaction.subjectAgentId ?? interaction.agentId;
  const now = new Date();
  // Повторный PATCH не начисляет баллы: ровно один запрос может забрать переход.
  const claimed = await db.interaction.updateMany({
    where: { id: interaction.id, completedAt: null, taskCancelledAt: null, ...(expected ? { AND: [expected] } : {}) },
    data: { completedAt: now },
  });

  if (claimed.count > 0 && taskOwnerId) {
    const overdue = interaction.nextActionDate != null && interaction.nextActionDate < now;
    const kind = completionEventKind(interaction.type, overdue);
    const points = await loadEventPoints(db);
    const event = {
      agentId: taskOwnerId,
      kind,
      delta: points[kind],
      reason: overdue ? "Закрыто с опозданием" : "Закрыто вовремя",
      sourceId: interaction.id,
    };
    if (tx) await recordScoreEventInTransaction(tx, event);
    else await recordScoreEvent(event);
  }
  if (claimed.count > 0 && !tx) afterInteractionTaskCompleted(interaction);

  // Повторный REST-запрос получает исходное время закрытия.
  const row = (await db.interaction.findUnique({ where: { id: interaction.id } })) ??
    { ...interaction, completedAt: now };
  return { row, changed: claimed.count > 0 };
}
