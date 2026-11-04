import { prisma } from "../db.js";
import type { Interaction, Prisma } from "../generated/prisma/client.js";
import { closeMeetingReminderPushes } from "./meetingReminders.js";
import { closeStaleNextActions } from "./nextActionAutoClose.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "./scoreJournal.js";

/** Ступень Royal Score по завершению задачи: свой вид события для показа, встречи и
 * обычной задачи (таблица владельца различает их ценой — «Показ +3», «Встреча +2»,
 * «Задача +1»), и просрочка считается по nextActionDate, а не самим фактом закрытия. */
function completionEventKind(type: string, overdue: boolean): ScoreEventKind {
  if (type === "SHOWING") return overdue ? "showing_missed" : "showing_done";
  if (type === "MEETING") return overdue ? "meeting_overdue" : "meeting_done";
  return overdue ? "task_overdue" : "task_on_time";
}

/** Shared transition for the CRM button and the assistant. Callers authorize the task first. */
export async function completeInteractionTask(interaction: Interaction, expected?: Prisma.InteractionWhereInput) {
  const taskOwnerId = interaction.subjectAgentId ?? interaction.agentId;
  const now = new Date();
  /**
   * ПЕРЕХОД «не выполнено → выполнено» ЗАБИРАЕТСЯ АТОМАРНО.
   *
   * Признаком первого перехода было прочитанное выше `interaction.completedAt` —
   * но между чтением и записью помещается второй такой же запрос (двойной клик,
   * повтор с телефона): оба видели `null`, оба заходили в начисление. От двойных
   * баллов спасала только уникальность `sourceId` в журнале — то есть защита жила
   * не там, где гонка, и любое событие без sourceId её бы не получило.
   *
   * `updateMany` с условием `completedAt: null` делает переход однократным на
   * стороне базы: `count > 0` ровно у одного запроса (тот же приём, что в
   * lib/telephony/qualifyIncoming.ts).
   */
  const claimed = await prisma.interaction.updateMany({
    where: { id: interaction.id, completedAt: null, taskCancelledAt: null, ...(expected ? { AND: [expected] } : {}) },
    data: { completedAt: now },
  });

  // Событие пишем только на переходе «не выполнено → выполнено» — повторный вызов
  // на уже закрытой задаче (двойной клик, повтор запроса) не должен начислять
  // баллы второй раз. sourceId = id взаимодействия даёт ту же защиту на уровне БД.
  if (claimed.count > 0) {
    const overdue = interaction.nextActionDate != null && interaction.nextActionDate < now;
    const kind = completionEventKind(interaction.type, overdue);
    // Цена — из настроек НА МОМЕНТ события: computeRoyalScore при расчёте всё равно
    // берёт актуальную цену по kind (см. scoreJournal.ts), а здесь delta нужна только
    // для того, что видит агент в журнале — «за что и сколько» без пересчёта задним числом.
    const points = await loadEventPoints();
    // await обязателен. Без него ответ 200 уходил раньше записи события, и всё, что
    // случалось дальше (падение процесса, откат соединения с базой), теряло балл
    // агента совсем: повторный PATCH уже видит completedAt и в эту ветку не заходит,
    // то есть второго шанса начислить не будет. Сам recordScoreEvent не бросает —
    // отказ пишется в журнал ошибок внутри него (аудит 12.08.2026, пункт К).
    if (taskOwnerId) {
      await recordScoreEvent({
        agentId: taskOwnerId,
        kind,
        delta: points[kind],
        reason: overdue ? "Закрыто с опозданием" : "Закрыто вовремя",
        sourceId: interaction.id,
      });
    }

    // ЗАКРЫТЬ СТАРЫЕ ПОДСКАЗКИ КЛИЕНТА (18.08.2026, см. lib/nextActionAutoClose.ts):
    // только для показа/встречи — сама встреча состоялась, значит это реальный
    // контакт, а не просто «отметили галочку» на произвольной задаче. Обычную
    // задачу (type=TASK/SYSTEM) закрывать чужие подсказки клиента не заставляет —
    // не всякая закрытая галочка означает, что с клиентом что-то произошло.
    if (interaction.type === "SHOWING" || interaction.type === "MEETING") {
      void closeStaleNextActions(interaction.clientId, interaction.id).catch((err) =>
        console.error("[interactions] закрытие старых подсказок:", err instanceof Error ? err.message : err)
      );
    }

    // Задача закрыта — все пуши про неё (наблюдателям показа, «не отмечен»,
    // «просрочено») больше не актуальны ни для кого, кроме исполнителя.
    if (taskOwnerId) void closeMeetingReminderPushes(interaction.id, taskOwnerId).catch((err) =>
      console.error("[interactions] закрытие пушей по задаче:", err instanceof Error ? err.message : err)
    );

    // «Итог показа» больше не заводится здесь (переработка 12.08.2026): окно
    // открывается ПО ВРЕМЕНИ показа (+90 минут после nextActionDate), независимо от
    // того, отметил ли агент задачу «выполненной» — см.
    // lib/pendingSummaries.ts::requireMeetingSummaries и cron.ts. Раньше агент, не
    // заходивший в CRM после показа, обязательного окна не получал вовсе.
  }
  // Return the first completion on repeated REST requests, even under concurrency.
  const row = (await prisma.interaction.findUnique({ where: { id: interaction.id } })) ??
    { ...interaction, completedAt: now };
  return { row, changed: claimed.count > 0 };
}
