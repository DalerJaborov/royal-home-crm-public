import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { loadTrafficLightSettings } from "./inactiveTrafficLight.js";

/**
 * СЧЁТЧИК АНОМАЛИЙ «ПЕРЕНОС ЗАДАЧИ БЕЗ КОНТАКТА» (04.09.2026, находка аудита,
 * согласовано владельцем).
 *
 * ДЫРА, КОТОРУЮ ЗАКРЫВАЕМ. buyerNoCallAlarm.ts/sellerNoPropertyAlarm.ts молчат,
 * если у клиента есть незакрытая задача с `nextActionDate` в будущем
 * (`explainedSilence` — «продавец честно сказал вернётся через 20 дней»). Но
 * ничто не мешает агенту двигать эту дату сколько угодно раз через ассистента
 * (`ai/assistant.ts::reschedule_task`), ни разу реально не связавшись с
 * клиентом — аларм молчит вечно, хотя работы по факту нет.
 *
 * ТОТ ЖЕ ПАТТЕРН, ЧТО У agentHandoffAnomalyAlarm.ts:
 *  - Источник правды — AuditLog (без миграции, без нового поля-счётчика на
 *    Client/Interaction). Каждый перенос пишет запись `action="TASK_RESCHEDULE"`,
 *    `entityType="Client"`, `entityId=clientId` — тот же приём, что и у
 *    передач/отказов NO_TRUST. МИНИМАЛЬНОЕ ПО ОБЪЁМУ РЕШЕНИЕ: отдельная таблица
 *    истории переносов или новое поле на Interaction добавили бы миграцию ради
 *    данных, которые AuditLog уже умеет хранить и по которым уже есть индекс
 *    (entityId, createdAt).
 *  - isWithinWorkingHours директора не будит ночью (решение владельца «3б») —
 *    счётчик (AuditLog) пишется ВСЕГДА, аларм — только в рабочие часы.
 *  - Дедуп по tag на клиента — повторное превышение схлопывается в одну строку
 *    ленты (upsertByTag, count++).
 *
 * ЧТО СЧИТАЕТСЯ «ПОДРЯД БЕЗ КОНТАКТА». Идём от САМОГО СВЕЖЕГО переноса этого
 * клиента к более старым. Перенос входит в серию, если между НИМ и
 * ПРЕДЫДУЩИМ переносом не было реального контакта. Серия обрывается на первом
 * переносе, перед которым контакт был — то есть «3 подряд» это ровно то, что
 * подразумевает фраза владельца, а не "3 переноса когда-либо у этого клиента".
 *
 * «РЕАЛЬНЫЙ КОНТАКТ» — та же метрика, что `countContactTrace.talked` в
 * inactiveTrafficLight.ts (звонок длиннее Settings.leadCallMinSeconds/со
 * взятой трубкой, или ответ клиента в переписке), но с окном по времени: сам
 * countContactTrace считает «хоть раз за всю историю», а здесь нужно «между
 * ЭТИМИ двумя переносами» — переиспользовать один в один нельзя, копия ниже
 * (hasRealContactBetween) использует ТЕ ЖЕ поля и то же пороговое значение
 * (Settings.leadCallMinSeconds), не заводит второе число.
 */

const ANOMALY_THRESHOLD = 3;
const TASK_RESCHEDULE_ACTION = "TASK_RESCHEDULE";

/** Реальный контакт с клиентом строго внутри (since, until] — состоявшийся
 *  разговор (та же планка длительности, что и «дозвонились» во всей CRM) или
 *  ответ клиента в переписке. Недозвон (NO_ANSWER) и ручной «нажал и бросил»
 *  НЕ считаются — ровно то, от чего защищает explainedSilence сегодня, и ровно
 *  то, чем агент не может прикрыть перенос без контакта. */
async function hasRealContactBetween(clientId: string, since: Date, until: Date, minSeconds: number): Promise<boolean> {
  const [call, client] = await Promise.all([
    prisma.interaction.findFirst({
      where: {
        clientId,
        type: "CALL",
        createdAt: { gt: since, lte: until },
        OR: [{ recordingDurationSec: { gte: minSeconds } }, { callAttempt: "TALKED" }],
      },
      select: { id: true },
    }),
    prisma.client.findUnique({ where: { id: clientId }, select: { lastClientMessageAt: true } }),
  ]);
  if (call) return true;
  return !!(client?.lastClientMessageAt && client.lastClientMessageAt > since && client.lastClientMessageAt <= until);
}

export async function noteTaskRescheduleAndAlarmIfAnomalous(input: {
  clientId: string;
  client: { shortId: number; fullName: string };
  agentId: string;
  interactionId: string;
  previousDate: Date;
  newDate: Date;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId }, select: { fullName: true } });
    await prisma.auditLog.create({
      data: {
        action: TASK_RESCHEDULE_ACTION,
        entityType: "Client",
        entityId: input.clientId,
        agentId: input.agentId,
        agentName: agent?.fullName ?? "Неизвестно",
        meta: {
          interactionId: input.interactionId,
          previousDate: input.previousDate.toISOString(),
          newDate: input.newDate.toISOString(),
        },
      },
    });

    // ANOMALY_THRESHOLD+2 записей с запасом хватает, чтобы надёжно отличить серию
    // длиннее ANOMALY_THRESHOLD от более короткой, не читая лишнего: streak растёт
    // от 1 (только что случившийся перенос) на каждый чистый промежуток перед ним.
    const recent = await prisma.auditLog.findMany({
      where: { entityType: "Client", entityId: input.clientId, action: TASK_RESCHEDULE_ACTION },
      orderBy: { createdAt: "desc" },
      take: ANOMALY_THRESHOLD + 2,
      select: { createdAt: true },
    });
    if (recent.length <= ANOMALY_THRESHOLD) return;

    const { leadCallMinSeconds } = await loadTrafficLightSettings();
    // Только что случившийся перенос сам по себе уже входит в серию — streak
    // считает СОБЫТИЯ переноса, а не промежутки между ними (та же единица
    // измерения, что и `count` в agentHandoffAnomalyAlarm.ts).
    let streak = 1;
    for (let i = 0; i < recent.length - 1; i++) {
      const hadContact = await hasRealContactBetween(
        input.clientId,
        recent[i + 1].createdAt,
        recent[i].createdAt,
        leadCallMinSeconds
      );
      if (hadContact) break;
      streak++;
    }
    if (streak <= ANOMALY_THRESHOLD) return;

    // Директора не будим ночью — решение владельца 03.09.2026 «3б», тот же
    // приём, что у agentHandoffAnomalyAlarm.ts. Счётчик уже записан выше и не
    // потеряется: следующий перенос (или следующий рабочий час — дедуп по tag
    // ниже всё равно один на клиента) досчитает сам.
    if (!(await isWithinWorkingHours(now))) return;

    const directorIds = (
      await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } })
    ).map((d) => d.id);
    if (directorIds.length === 0) return;

    // Один tag на клиента — повторные переносы сверх порога схлопываются в одну
    // строку ленты (createNotifications::upsertByTag, count++), а не плодят пуш
    // на каждый следующий перенос.
    const tag = `alarm-task-reschedule-no-contact-${input.clientId}`;
    const payload = {
      kind: "oversight" as const,
      title: `⚠️ Перенос задачи без контакта: ${input.client.fullName}`,
      // Когда/от кого(агент)/про кого(клиент)/что — одним текстом.
      body: `${dushanbeDateTimeString(now)}, агент ${agent?.fullName ?? "агент"}: дата задачи перенесена ${streak}-й раз подряд без реального контакта с клиентом (ни звонка, ни ответа в переписке между переносами)`,
      url: `/clients/${input.client.shortId}`,
      tag,
    };
    await createNotifications(directorIds, payload);
    void sendPushToAgents(directorIds, payload).catch((err) =>
      console.error("[alarm] task-reschedule-no-contact push:", err)
    );
  } catch (err) {
    // Сигнал руководителю не важнее самого переноса задачи — не роняем ассистента
    // из-за непрочитанного счётчика (тот же приём, что у agentHandoffAnomalyAlarm.ts).
    console.error("[alarm] task-reschedule-no-contact:", err instanceof Error ? err.message : err);
  }
}
