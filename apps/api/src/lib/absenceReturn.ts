import { dushanbeDayKey } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { invalidateAgentAccess } from "../auth/middleware.js";
import { syncAgentQueuePresence } from "./telephony/operatorQueue.js";
import { findAgentsWithPermission } from "./recipients.js";
import { shiftInactiveClockAfterAbsence } from "./inactiveTrafficLight.js";

/**
 * СОТРУДНИК ВЫШЕЛ ИЗ ОТПУСКА САМ (владелец 09.09.2026).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ТИК. Отпуск ставится с датой выхода, и без этого прохода снять
 * его пришлось бы руками. Забытая заморозка стоит дорого и молча: агент вышел на
 * работу, а лиды ему не идут (services/leads/selection.ts фильтрует frozenAt),
 * входящие звонки к нему не приходят (очередь АТС на паузе), Royal Score его не
 * считает. Человек сидит в офисе и не понимает, почему у него пусто, — а система
 * при этом ни на что не жалуется.
 *
 * СНИМАЕТСЯ ТОЛЬКО ОТСУТСТВИЕ С ДАТОЙ. Больничный «до неизвестно когда»
 * (absenceUntil = null) не трогаем вовсе: человек выходит тогда, когда выходит, и
 * возвращать его в строй по догадке нельзя — ему тут же пойдут лиды и звонки.
 * Такое отсутствие снимает руководитель кнопкой «вернулся».
 *
 * УВОЛЕННЫХ НЕ ВОЗВРАЩАЕМ: isActive=false — решение сильнее любой даты в календаре.
 */
export async function runAbsenceReturnTick(now: Date = new Date()): Promise<{ returned: number }> {
  const due = await prisma.agent.findMany({
    where: {
      isActive: true,
      frozenAt: { not: null },
      absenceUntil: { not: null, lte: now },
    },
    select: { id: true, fullName: true, absenceKind: true, frozenAt: true },
  });
  if (due.length === 0) return { returned: 0 };

  let returned = 0;
  const returnedNames: string[] = [];
  for (const agent of due) {
    try {
      /**
       * Условная запись: между выборкой и апдейтом руководитель мог продлить
       * отпуск или снять его сам. `updateMany` с тем же условием по дате вернёт
       * 0 — и это не ошибка, а нормальная гонка.
       */
      /**
       * Разморозка и сдвиг часов светофора — одной транзакцией (владелец
       * 23.09.2026): время отпуска в срок неактивных клиентов не идёт, иначе
       * вернувшийся агент на первом же тике терял их пачкой. См.
       * lib/inactiveTrafficLight.ts::shiftInactiveClockAfterAbsence. Сдвиг —
       * только если разморозка действительно состоялась (count > 0).
       */
      const count = await prisma.$transaction(async (tx) => {
        const res = await tx.agent.updateMany({
          where: { id: agent.id, frozenAt: { not: null }, absenceUntil: { not: null, lte: now } },
          // Ровно то же, что снимает ручная разморозка (routes/agents.ts,
          // POST /:id/unfreeze): недоснятая причина заморозки осталась бы висеть в
          // карточке сотрудника, который уже вернулся.
          data: {
            frozenAt: null,
            frozenById: null,
            frozenReason: null,
            frozenReasonVoiceUrl: null,
            frozenReasonVoiceTranscript: null,
            absenceKind: null,
            absenceUntil: null,
          },
        });
        if (res.count > 0) await shiftInactiveClockAfterAbsence(agent.id, agent.frozenAt, now, tx);
        return res.count;
      });
      if (count === 0) continue;

      invalidateAgentAccess(agent.id);
      // Без этого агент вернулся в CRM, но остался на паузе в очереди АТС —
      // входящие звонки продолжали бы обходить его стороной.
      void syncAgentQueuePresence(agent.id).catch(() => {});
      returned++;
      returnedNames.push(agent.fullName);

      void sendPushToAgent(agent.id, {
        title: "👋 С возвращением",
        body: "Отпуск закончился — новые лиды и входящие звонки снова идут к вам.",
        url: "/",
        tag: `absence-return-${agent.id}`,
      }).catch(() => {});
    } catch (err) {
      console.error("[отсутствие] возврат сотрудника:", err instanceof Error ? err.message : err);
    }
  }

  if (returned > 0) {
    // Только действительно вернувшиеся (Ф12, 02.10.2026): раньше в список
    // попадали и те, кого разморозить не удалось (гонка, сбой).
    const names = returnedNames.join(", ");
    const recipients = await findAgentsWithPermission("agents.manage");
    void sendPushToAgents(recipients, {
      title: "👋 Сотрудник вышел",
      body: `${names} — отсутствие закончилось, лиды снова распределяются на него.`,
      url: "/team",
      tag: `absence-return-batch-${dushanbeDayKey(now)}`,
    }).catch(() => {});
  }

  return { returned };
}
