import { prisma } from "../db.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { sendPushToAgent } from "../push.js";

/**
 * ВОЗВРАТ ПЕРЕДАННЫХ ДЕЛ (владелец 24.09.2026: «верни всех клиентов и объекты
 * Сурайё на место, она вернулась на работу, и добавь такую же кнопку для
 * возврата… даже после деактивации, чтобы была возможность вернуть всё так,
 * как есть и было»).
 *
 * Возврат идёт по снимку `AgentHandoverBatch.items`, который «Передать дела»
 * пишет в момент раздачи: кому ушёл каждый клиент, каждая задача и каждый
 * объект, и какими они были до этого (acceptedAt/assignedAt у клиента, поля
 * хозяина и отметка «принять» у объекта, agentId/subjectAgentId у задачи).
 *
 * ТРОГАЕМ ТОЛЬКО ТО, ЧТО ВСЁ ЕЩЁ У ПОЛУЧАТЕЛЯ. Карточку, которую за это время
 * передали дальше, отклонили в очередь или закрыли сделкой, не отбираем: это
 * уже чьё-то новое решение, а не последствие раздачи. Такие считаются
 * пропущенными и показываются руководителю числом.
 *
 * Клиент возвращается ПРИНЯТЫМ (acceptedAt как до раздачи): сотрудник вернулся
 * к СВОИМ клиентам, таймер первого звонка по ним не нужен. Всё, что получатель
 * успел записать в историю (звонки, заметки), остаётся — историю не переписываем.
 * Что не вернуть: отклонённые при раздаче заявки на удаление — их прежний
 * хозяин при желании подаст заново.
 */
export interface HandoverSnapshotItems {
  clients: {
    clientId: string;
    toAgentId: string;
    acceptedAt: string | null;
    assignedAt: string | null;
  }[];
  tasks: {
    interactionId: string;
    /** Кем была задача до раздачи: agentId (задача агента) или subjectAgentId (задача бота/системы). */
    field: "agentId" | "subjectAgentId";
    toAgentId: string;
  }[];
  properties: {
    propertyId: string;
    toAgentId: string;
    intakeAgentId: string | null;
    assignedAgentId: string | null;
    handoverPendingSince: string | null;
    handoverFromAgentId: string | null;
    handoverReason: string | null;
  }[];
}

export interface HandoverRevertResult {
  clients: number;
  tasks: number;
  properties: number;
  skippedClients: number;
  skippedProperties: number;
  /** Учётка была отключена той же раздачей и включена обратно. */
  reactivated: boolean;
}

export type HandoverRevertOutcome = { ok: true; result: HandoverRevertResult } | { ok: false; reason: "not_found" | "already_reverted" };

export async function revertAgentHandover(batchId: string, actorId: string | null): Promise<HandoverRevertOutcome> {
  const batch = await prisma.agentHandoverBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, reason: "not_found" };
  if (batch.revertedAt) return { ok: false, reason: "already_reverted" };
  const items = batch.items as unknown as HandoverSnapshotItems;
  const fromAgentId = batch.fromAgentId;
  const actor = actorId ? await prisma.agent.findUnique({ where: { id: actorId }, select: { fullName: true } }) : null;
  const actorName = actor?.fullName ?? "Система";
  const from = await prisma.agent.findUnique({ where: { id: fromAgentId }, select: { fullName: true, isActive: true } });
  const reason = `Возврат дел: ${from?.fullName ?? "сотрудник"} снова в работе, карточка возвращена прежнему агенту`;

  const result: HandoverRevertResult = { clients: 0, tasks: 0, properties: 0, skippedClients: 0, skippedProperties: 0, reactivated: false };
  const receivers = new Set<string>();

  // Учётку включаем ПЕРВОЙ: changeClientAgent и объекты ниже проверяют
  // получателя на активность не везде, но человек, которому возвращают дела,
  // обязан быть в строю до того, как на него снова лягут клиенты.
  if (batch.deactivated && from && !from.isActive) {
    await prisma.agent.update({ where: { id: fromAgentId }, data: { isActive: true } });
    result.reactivated = true;
  }

  for (const item of items.clients ?? []) {
    const changed = await changeClientAgent({
      clientId: item.clientId,
      toAgentId: fromAgentId,
      reason,
      actorId,
      actorName,
      interactionAgentId: fromAgentId,
      source: "handover-revert",
      data: {
        acceptedAt: item.acceptedAt ? new Date(item.acceptedAt) : new Date(),
        assignedAt: item.assignedAt ? new Date(item.assignedAt) : new Date(),
      },
      // Объекты возвращаем ниже по своему снимку, а не связкой: связка тянула бы
      // и те объекты, что получатель успел принять у собственника сам.
      skipProperties: true,
      // Только если карточка всё ещё у получателя из снимка.
      guardWhere: { assignedAgentId: item.toAgentId },
    });
    if (changed.ok) {
      result.clients++;
      receivers.add(item.toAgentId);
    } else {
      result.skippedClients++;
    }
  }

  // Открытые задачи возвращаются двумя путями: спутники changeClientAgent
  // (lib/ownershipSatellites.ts) тянут их за клиентом, а этот цикл добирает то, что
  // спутники не увидели (задачи без даты, задачи бота). Считаем по факту: задача
  // снова у вернувшегося — значит, вернулась, кем бы её ни перевесили.
  for (const item of items.tasks ?? []) {
    const row = await prisma.interaction.findUnique({
      where: { id: item.interactionId },
      select: { agentId: true, subjectAgentId: true, completedAt: true },
    });
    if (!row || row.completedAt) continue;
    const holder = item.field === "agentId" ? row.agentId : row.subjectAgentId;
    if (holder === item.toAgentId) {
      // Запись с условием на того же держателя и на «не закрыта» (аудит 04.10.2026, CRM-04):
      // между чтением и записью задачу могли передать третьему, и откат затёр бы его решение.
      const moved = await prisma.interaction.updateMany({
        where: { id: item.interactionId, completedAt: null, [item.field]: item.toAgentId },
        data: item.field === "agentId" ? { agentId: fromAgentId } : { subjectAgentId: fromAgentId },
      });
      if (moved.count === 1) result.tasks++;
    } else if (holder === fromAgentId) {
      result.tasks++;
    }
  }

  for (const item of items.properties ?? []) {
    const current = await prisma.property.findUnique({
      where: { id: item.propertyId },
      select: { id: true, shortId: true, title: true, status: true, deletedAt: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    });
    if (!current || current.deletedAt || propertyOwnerAgentId(current) !== item.toAgentId) {
      result.skippedProperties++;
      continue;
    }
    // Запись с условием на хозяина из ЭТОГО чтения (аудит 04.10.2026, CRM-04): как у клиентов
    // выше, где стоит guardWhere. Другой руководитель мог назначить объект третьему между
    // findUnique и записью, и откат затёр бы его решение полями прежнего агента. Проиграли
    // гонку: пропускаем объект, журнал не пишем.
    const reverted = await prisma.$transaction(async (tx) => {
      const written = await tx.property.updateMany({
        where: {
          id: current.id,
          deletedAt: null,
          intakeAgentId: current.intakeAgentId,
          assignedAgentId: current.assignedAgentId,
        },
        data: {
          intakeAgentId: item.intakeAgentId,
          assignedAgentId: item.assignedAgentId,
          handoverPendingSince: item.handoverPendingSince ? new Date(item.handoverPendingSince) : null,
          handoverFromAgentId: item.handoverFromAgentId,
          handoverReason: item.handoverReason,
        },
      });
      if (written.count !== 1) return false;
      await tx.auditLog.create({
        data: {
          action: "PROPERTY_HANDOVER_REVERT",
          entityType: "Property",
          entityId: current.id,
          agentId: actorId,
          agentName: actorName,
          meta: { batchId, fromAgentId: item.toAgentId, toAgentId: propertyOwnerAgentId(item) ?? fromAgentId, shortId: current.shortId, title: current.title, reason },
        },
      });
      return true;
    });
    if (!reverted) {
      result.skippedProperties++;
      continue;
    }
    publishPropertyUpdated({ propertyId: current.id, agentId: fromAgentId, stage: current.status, actorId });
    result.properties++;
    receivers.add(item.toAgentId);
  }

  await prisma.agentHandoverBatch.update({
    where: { id: batchId },
    data: { revertedAt: new Date(), revertedById: actorId, revertSummary: { ...result } },
  });

  // Получатели узнают, что карточки ушли обратно, — иначе список у них просто
  // редеет без объяснений; вернувшийся — что всё снова у него.
  for (const agentId of receivers) {
    void sendPushToAgent(agentId, {
      title: `↩️ Дела возвращены: ${from?.fullName ?? "сотрудник"} снова в работе`,
      body: "Переданные вам клиенты и объекты вернулись прежнему агенту. Ваши записи в истории остались.",
      url: "/clients",
      tag: `handover-revert-${batchId}`,
    }).catch(() => {});
  }
  if (result.clients > 0 || result.properties > 0) {
    void sendPushToAgent(fromAgentId, {
      title: "↩️ Ваши дела возвращены",
      body: `Клиентов: ${result.clients}, задач: ${result.tasks}, объектов: ${result.properties}. С возвращением!`,
      url: "/clients",
      tag: `handover-revert-${batchId}`,
    }).catch(() => {});
  }

  return { ok: true, result };
}
