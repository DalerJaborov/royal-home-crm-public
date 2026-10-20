/**
 * «Неактивный» (ТЗ п. 22, переработка 12.08.2026): клиент временно перестал
 * общаться или отложил покупку. Это НЕ передача другому агенту (см.
 * lib/clientTransfer.ts) и НЕ потеря (Client.status не трогаем) — агент за
 * клиентом остаётся, только слот в лимите активных лидов освобождается
 * (activeLeadCounts считает по OCCUPIES_SLOT_WHERE — workStatus="ACTIVE", см. lib/leadLimits.ts).
 *
 * Один и тот же вызов используется из окна «Как прошёл звонок» (call_result) и
 * из окна «Итог показа» (meeting) — обе формы просят одинаковый набор полей.
 */
import { sellersWithPropertyInWork } from "./sellerCardState.js";
import {
  INACTIVE_REASON_LABELS,
  REFUSAL_INITIATOR_LABELS,
  type InactiveReason,
  type RefusalInitiator,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import {
  canDeactivateWithReason,
  inactiveLevelFields,
  lastRealContactAt,
} from "./inactiveTrafficLight.js";
import { REAL_CALL_CONTACT_WHERE, TERMINAL_CLIENT_STATUSES } from "./clientContact.js";
import { reactivationResetData } from "./clientLifecycle.js";
import { publishClientUpdated } from "./livePublish.js";
import { logTimeline, type TimelineActor } from "./timeline.js";

export interface DeactivateClientInput {
  clientId: string;
  /**
   * Кто на самом деле перевёл карточку (П-10). Ручного перехода больше нет
   * (убран 16.09.2026, me.ts) — сейчас сюда приходят только `ai` (разбор
   * звонка/переписки) и `system` (авто-детектор серии недозвонов). Держатель
   * карточки (`client.assignedAgentId`) — адресат уведомления ниже, а не актор.
   */
  actor: TimelineActor;
  reason: InactiveReason;
  initiator: RefusalInitiator;
  actualNeeds: string;
  comment?: string;
  voiceNoteUrl?: string;
  voiceNoteTranscript?: string;
  /** Timestamp of the call/message being analysed; newer contact wins. */
  evidenceAt?: Date;
  expectedAgentId?: string | null;
}

export type DeactivateClientResult =
  | { ok: true }
  | { ok: false; reason?: string };

/**
 * ВЕРНУТЬ КЛИЕНТА В РАБОТУ — руками, не дожидаясь, пока он сам напишет.
 *
 * До 14.08.2026 обратного перехода не было вовсе: «Неактивный» стоял дверью в одну
 * сторону, и единственным способом вернуть клиента было его собственное сообщение
 * в канал (leads.ts::createLeadFromChannel). Агент, отложивший клиента по ошибке
 * или сам дозвонившийся до него позже, исправить это не мог никак.
 *
 * Лимит активных лидов здесь НЕ блокирует — как и при возврате по сообщению
 * клиента: карточка и так закреплена за этим агентом, отказывать ему в работе со
 * своим же клиентом не за что. Превышение лимита разбирает руководитель по тому
 * же уведомлению, что и в leads.ts.
 */
export async function reactivateClient(input: {
  clientId: string;
  agentId: string;
}): Promise<{ ok: boolean }> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, status: true, workStatus: true, assignedAgentId: true, inactiveSince: true },
  });
  if (!client) return { ok: false };
  if (client.assignedAgentId !== input.agentId || client.status === "ARCHIVED" || client.status === "DEAL_CLOSED")
    return { ok: false };
  // Уже активен — не пишем в хронологию пустое событие: повторное нажатие кнопки
  // не должно оставлять следов «вернул в работу» подряд.
  if (client.workStatus === "ACTIVE") return { ok: true };
  if (client.workStatus !== "INACTIVE") return { ok: false };

  /**
   * ВОЗВРАТ ЧИСТИТ ПОЛЯ СВЕТОФОРА, А НЕ ТОЛЬКО workStatus (07.09.2026, находка №25
   * из docs/audit-findings-2026-09-05.md).
   *
   * Здесь стояло `data: { workStatus: "ACTIVE" }`, и inactiveLevel/inactiveReasonKey/
   * inactiveSince/inactivePingCount оставались от прошлой жизни карточки. Владелец
   * видел это на своей карточке: клиент вернулся в работу, а рядом с ним по-прежнему
   * висел красный уровень светофора — от перевода в неактивные месячной давности.
   * Хуже тихо: при следующем переводе в неактивные счётчик попыток продолжался со
   * старого значения, то есть «предел попыток исчерпан» наступал досрочно и карточка
   * улетала в LOST раньше срока.
   *
   * Готовый хелпер reactivationResetData уже существовал и делал ровно это, но
   * вызывался только на пути POST /:id/assign — два пути к одному состоянию
   * разошлись молча. Теперь общий.
   */
  const written = await prisma.$transaction(async (tx) => {
    const updated = await tx.client.updateMany({
      where: { id: client.id, deletedAt: null, assignedAgentId: input.agentId,
        status: client.status, workStatus: "INACTIVE", inactiveSince: client.inactiveSince },
      data: { ...reactivationResetData({
        status: client.status,
        workStatus: client.workStatus,
      }), returnedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await logTimeline({
      clientId: client.id,
      actor: { kind: "agent", agentId: input.agentId },
      type: "SYSTEM",
      notes: "Клиент возвращён в работу из Неактивных",
      tx,
    });
    return true;
  });
  if (!written) return { ok: false };
  // Клиент снова в активных: его списки и светофор надзора протухли.
  publishClientUpdated({
    clientId: client.id,
    agentIds: [input.agentId],
    stage: "ACTIVE",
    actorId: input.agentId,
  });
  return { ok: true };
}

/**
 * ЕСТЬ ЛИ У КЛИЕНТА КОНТАКТ СВЕЖЕЕ, ЧЕМ `since` (ПР-000381, 24.09.2026).
 *
 * Разбор звонка ИИ асинхронный (конвейер расшифровки — минуты), и к моменту,
 * когда разбор ДОБИРАЕТСЯ до деактивации, разбираемый звонок мог быть давно
 * неактуален: клиент уже вернулся в работу сам (lib/telephony/autoLeadFromCall.ts
 * ставит Client.returnedAt на «Клиент позвонил сам — возвращён в работу»),
 * ответил на более поздний звонок, или написал в мессенджер. Деактивация по
 * такому устаревшему разбору тихо перечёркивает то, что уже произошло — лента
 * ПР-000381 20.09 16:02 поймала именно это: «ИИ перевёл в Неактивные» и в ту же
 * минуту «Клиент позвонил сам — возвращён в работу».
 *
 * Три признака более свежей жизни карточки, любой — повод не доверять разбору:
 *  1. Client.returnedAt позже `since` — реактивация (ручная, из LOST, или именно
 *     звонок клиента, см. выше).
 *  2. Более поздний СОСТОЯВШИЙСЯ звонок (запись есть, либо исход не «не дозвонились») —
 *     тот же критерий «контакт был», что и в lib/telephony/botPauseWatch.ts
 *     (fetchLastCallContactByClient) и lib/silentClientAutoDeactivate.ts.
 *  3. Более позднее входящее сообщение — ContactProfile.lastSeenAt (общее досье по
 *     любому каналу, не только по BotConversation одного канала).
 *
 * Один параллельный набор запросов — вызывается один раз на разбираемый звонок,
 * не в цикле по клиентам, поэтому N+1 здесь нет и не появляется при росте базы.
 */
export async function hasNewerContactSince(clientId: string, since: Date): Promise<boolean> {
  const [client, contacts, newerMessage] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { returnedAt: true, lastClientMessageAt: true } }),
    lastRealContactAt([{ id: clientId, inactiveSince: since }]),
    prisma.contactProfile.findFirst({
      where: { clientId, lastSeenAt: { gt: since } },
      select: { id: true },
    }),
  ]);
  return Boolean((client?.returnedAt && client.returnedAt > since) ||
    (client?.lastClientMessageAt && client.lastClientMessageAt > since) || contacts.has(clientId) || newerMessage);
}

/**
 * ГЕЙТ + СВЕТОФОР (мозговой штурм 21.08.2026, «рубеж 3: слив со следом работы»).
 *
 * До перевода в Неактивные проверяем, что агент реально пытался связаться
 * (canDeactivateWithReason — см. lib/inactiveTrafficLight.ts, там же почему это
 * закрывает лазейку «слить клиента ради свободного слота бесплатно»). Прошёл
 * гейт — вместе с workStatus пишем цвет светофора и точку отсчёта напоминаний
 * (inactiveLevelFields), чтобы cron их сразу подхватил.
 */
export async function deactivateClient(
  input: DeactivateClientInput,
): Promise<DeactivateClientResult> {
  const decisionAt = new Date();
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      kind: true,
      status: true,
      workStatus: true,
      returnedAt: true,
      lastClientMessageAt: true,
      reactivationOfferedToAgentId: true,
    },
  });
  if (!client) return { ok: false };
  if (client.workStatus !== "ACTIVE" || !client.assignedAgentId ||
    TERMINAL_CLIENT_STATUSES.some((status) => status === client.status) ||
    client.reactivationOfferedToAgentId ||
    (input.expectedAgentId !== undefined && input.expectedAgentId !== client.assignedAgentId)) {
    return { ok: false, reason: "Состояние или держатель карточки уже изменились" };
  }
  if (input.evidenceAt && await hasNewerContactSince(client.id, input.evidenceAt)) {
    return { ok: false, reason: "После этого события клиент снова был на связи" };
  }
  // Продавец с объектом в работе в «Неактивные» не уходит ни по разбору ИИ, ни
  // по недозвонам (владелец 23.09.2026): объект в каталоге — клиент живой.
  if (
    client.kind === "SELLER" &&
    (await sellersWithPropertyInWork([client.id])).has(client.id)
  ) {
    return { ok: false, reason: "У продавца объект в работе" };
  }

  const gate = await canDeactivateWithReason(input.clientId, input.reason);
  if (!gate.allowed) return { ok: false, reason: gate.reason };

  const reasonLabel = INACTIVE_REASON_LABELS[input.reason];
  const initiatorLabel = REFUSAL_INITIATOR_LABELS[input.initiator];
  const levelFields = await inactiveLevelFields(
    client.id,
    client.kind,
    input.reason,
  );
  const notes =
    `Клиент переведён в Неактивные: ${reasonLabel} (инициатор: ${initiatorLabel}). ` +
    `Актуальные потребности: ${input.actualNeeds.trim()}` +
    (input.comment?.trim() ? `. ${input.comment.trim()}` : "");

  const written = await prisma.$transaction(async (tx) => {
    const updated = await tx.client.updateMany({
      where: {
        id: client.id, deletedAt: null, status: { notIn: [...TERMINAL_CLIENT_STATUSES] }, workStatus: "ACTIVE",
        assignedAgentId: client.assignedAgentId, returnedAt: client.returnedAt,
        lastClientMessageAt: client.lastClientMessageAt,
        reactivationOfferedToAgentId: null,
        deals: { none: { stage: { notIn: ["COMPLETED", "CANCELLED"] } } },
        interactions: { none: { ...REAL_CALL_CONTACT_WHERE, createdAt: { gt: input.evidenceAt ?? decisionAt } } },
      },
      data: {
        workStatus: "INACTIVE",
        ...levelFields,
        // Точка отсчёта паузы выдачи лидов агенту (agentsInCooldown) — только
        // здесь, при входе, а не при каждом сбросе таймера светофора.
        inactiveEnteredAt: levelFields.inactiveSince,
        // Реактивация к прежнему агенту (п.12) — тот, кто вёл карточку,
        // остаётся адресатом предложения, даже когда слот освободится.
        ...(client.assignedAgentId
          ? { lastAgentId: client.assignedAgentId }
          : {}),
      },
    });
    if (updated.count !== 1) return false;
    // П-10: через logTimeline, не напрямую — actor приходит от вызывающей
    // стороны (ai/system, ручного перехода больше нет), а не выводится из
    // держателя карточки.
    await logTimeline({
      clientId: client.id,
      actor: input.actor,
      type: "SYSTEM",
      notes,
      voiceNoteUrl: input.voiceNoteUrl ?? null,
      voiceNoteTranscript: input.voiceNoteTranscript ?? null,
      tx,
    });
    return true;
  });
  if (!written) return { ok: false, reason: "Карточка изменилась во время проверки" };
  // Клиент ушёл в Неактивные: слот агента освободился, светофор надзора изменился.
  publishClientUpdated({
    clientId: client.id,
    agentIds: [client.assignedAgentId],
    stage: "INACTIVE",
  });

  // Пуш держателю «💤 Клиент переведён в Неактивные» убран владельцем 02.10.2026:
  // перевод и запись в таймлайн остались.

  // Гашение требований PendingSummary при деактивации отсюда убрано (14.09.2026):
  // обязательные окна итогов удалены целиком вместе с механизмом, гасить больше
  // нечего — см. docs памяти royalhome-mandatory-summary-windows-removed-14-09.

  return { ok: true };
}
