/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ»: ЛЮДЕЙ ЗОВЁТ ТОЛЬКО ЗАЯВКА (решение владельца 13.11.2026).
 *
 * Владелец дословно: «никаких уведомлений не надо никому высылать пока он не станет лидом, так же
 * правильнее, зачем шум и гам». Лид — это номер: в WhatsApp номер отправителя, в Instagram/Facebook —
 * номер, который прислал клиент. Поэтому в режиме:
 *  - без номера (интерес, понравившийся объект, горячие слова, вопрос к сотруднику) — ни пушей, ни записей
 *    в ленте: бот просит номер не больше заданного числа раз и даёт номер офиса;
 *  - номер есть — заявка штатным приёмом (acceptLead), агента выбирает обычная лесенка назначения CRM,
 *    и уведомляет его она же; режим своих пушей не добавляет;
 *  - карточка уже есть — агенту приходит обычное уведомление о сообщении (lib/clientMessageAlert.ts);
 *    режим только оставляет пометку в карточке, когда клиент назвал время звонка, просит не звонить
 *    или дал другой номер (`noteLeadOnlyOnCard`).
 *
 * Единственное, что зовёт людей отсюда, — сбой заявки, у которой номер уже есть (`alarmLeadOnlyIntake`):
 * клиент оставил номер и ждёт звонка, а карточки нет или её агент не назначен. Это тревога, а не «кто-то
 * интересуется»: хозяину объекта разговора, иначе руководителям, раздающим заявки.
 */
import { prisma } from "../db.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logTimeline } from "./timeline.js";
import { propertyInterestChatAgentIds } from "./ownBotConversationScope.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

export type LeadOnlyAlarmReason = "intake_failed" | "no_agent";
export type LeadOnlyAlarmResult =
  | { status: "notified"; to: "property" | "supervisors"; recipients: number }
  | { status: "nobody" };

const TITLES: Record<LeadOnlyAlarmReason, string> = {
  intake_failed: "⚠️ Заявка из переписки не оформилась",
  no_agent: "⚠️ Бот обещал звонок, а агента у заявки нет",
};

/** Метка тревог режима по диалогу (лента уведомлений; для поиска и уборки). */
export function leadOnlyAlarmTag(conversationId: string): string {
  return `lead-only-alarm-${conversationId}`;
}

/**
 * Номер есть, а заявка не оформилась (или ушла без агента при обещанном звонке): позвать человека к переписке.
 * Без окна тишины: это не повтор повода, а новая беда. В тексте пуша нет ни номера, ни слов клиента: экран
 * открывается по правам сотрудника, суть — в журнале ошибок. Бросает только при сбое базы.
 */
export async function alarmLeadOnlyIntake(input: { conversationId: string; propertyId: string | null;
  reason: LeadOnlyAlarmReason }): Promise<LeadOnlyAlarmResult> {
  const tag = `${leadOnlyAlarmTag(input.conversationId)}:${input.reason}`;
  const property = input.propertyId ? await prisma.property.findUnique({ where: { id: input.propertyId },
    select: { shortId: true, intakeAgentId: true, assignedAgentId: true, createdById: true, deletedAt: true } }) : null;
  const owners = new Set<string>();
  const owner = property && !property.deletedAt ? propertyOwnerAgentId(property) : null;
  if (owner) owners.add(owner);
  if (!owners.size) for (const id of await propertyInterestChatAgentIds(input.conversationId)) owners.add(id);
  const activeOwners = owners.size
    ? (await prisma.agent.findMany({ where: { id: { in: [...owners] }, isActive: true }, select: { id: true } })).map(a => a.id)
    : [];
  const payload = { kind: "message" as const, level: "CRITICAL" as const, title: TITLES[input.reason],
    body: property ? `Клиент оставил номер по объекту №${property.shortId}, а заявка не дошла до агента. Откройте переписку.`
      : "Клиент оставил номер, а заявка не дошла до агента. Откройте переписку.",
    url: `/messages?open=${input.conversationId}`, tag };
  if (activeOwners.length) {
    await deliver(activeOwners, payload);
    return { status: "notified", to: "property", recipients: activeOwners.length };
  }
  const supervisors = await findAgentsWithPermission("clients.assign");
  if (supervisors.length) {
    await deliver(supervisors, payload);
    return { status: "notified", to: "supervisors", recipients: supervisors.length };
  }
  void logSystemError("ai", `[alarm] Режим «только заявки»: заявка с номером не дошла до агента, а звать некого ` +
    `(диалог ${input.conversationId}). Откройте переписку и ответьте клиенту.`, { dedupKey: `lead-only-alarm-nobody:${input.conversationId}` });
  return { status: "nobody" };
}

/**
 * Пометка в карточке клиента, который уже лид (время звонка, «не звоните», другой номер). Без пуша: агенту
 * и так приходит обычное уведомление о сообщении клиента. false — карточки нет или она удалена.
 */
export async function noteLeadOnlyOnCard(input: { conversationId: string; summary: string }): Promise<boolean> {
  const conversation = await prisma.botConversation.findUnique({ where: { id: input.conversationId },
    select: { client: { select: { id: true, assignedAgentId: true, deletedAt: true } } } });
  const client = conversation?.client && !conversation.client.deletedAt ? conversation.client : null;
  if (!client) return false;
  await logTimeline({ clientId: client.id, type: "SYSTEM", notes: input.summary,
    actor: { kind: "client", source: "lead-only-mode", ...(client.assignedAgentId ? { subjectAgentId: client.assignedAgentId } : {}) } });
  return true;
}

async function deliver(agentIds: string[], payload: Parameters<typeof sendPushToAgents>[1]): Promise<void> {
  try {
    if (agentIds.length === 1) await sendPushToAgent(agentIds[0], payload);
    else await sendPushToAgents(agentIds, payload);
  } catch (err) {
    // Запись в ленте пишется до доставки на устройство; отказ доставки виден в журнале.
    void logSystemError("api", `Режим «только заявки»: пуш о сбое заявки не доставлен: ${describeError(err)}`,
      { dedupKey: "lead-only-alarm-push" });
  }
}
