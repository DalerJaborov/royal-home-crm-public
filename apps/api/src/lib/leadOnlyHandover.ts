/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ»: «ПЕРЕДАЮ АГЕНТУ» ЗНАЧИТ, ЧТО ЧЕЛОВЕК ПРАВДА УЗНАЛ (ревью 13.11.2026).
 *
 * Бот говорит клиенту «передаю агенту» в трёх случаях: горячие слова («хотим посмотреть»,
 * «куда ехать»), вопрос, который модель решила отдать сотруднику, и ответ, из которого фильтр
 * вырезал подборку или ссылку. До этой двери заявка заводилась только при известном номере,
 * поэтому в Instagram/Facebook без номера и у клиента с готовой карточкой (в ядре) не узнавал
 * никто, а прежний «передать сотруднику» ядра, ждавший человека молча, закрывался ответом бота.
 *
 * Здесь одна дверь на оба маршрута бота (ядро — из задания lib/customerLeadOnlyCore.ts, старый путь —
 * из messengers/conversation.ts). Кому:
 *  1. карточка есть и у неё агент — ему: пуш, запись в хронологии и метка «просит агента»
 *     (Client.agentAttentionRequestedAt) — список «Чаты» держит такой диалог первым и красным,
 *     пока агент не ответит сам или не дозвонится (гасит lib/conversationDelivery.ts);
 *  2. иначе агент объекта (объект этого хода, иначе объекты переписки) — пуш со ссылкой на чат;
 *  3. иначе руководители, раздающие заявки (право clients.assign), — пуш со ссылкой на чат.
 * Никого нет — тревога в журнал ошибок: обещание клиенту без адресата должно быть видно.
 *
 * Не дёргать людей на каждое «адрес?» (владелец 10.11: «редко беспокоить людей»): по одному
 * диалогу не чаще раза в LEAD_ONLY_HANDOVER_INTERVAL_MS — тем же shouldAlert, что у тревог.
 * В тексте пуша нет ни номера, ни слов клиента: экран открывается по правам сотрудника.
 */
import { prisma } from "../db.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { shouldAlert } from "./notifications.js";
import { logTimeline } from "./timeline.js";
import { propertyInterestChatAgentIds } from "./ownBotConversationScope.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

export const LEAD_ONLY_HANDOVER_INTERVAL_MS = 6 * 60 * 60_000;

export type LeadOnlyHandoverReason = "hot" | "escalate" | "filtered" | "intake_failed" | "no_agent";
export type LeadOnlyHandoverResult =
  | { status: "notified"; to: "assigned" | "property" | "supervisors"; recipients: number }
  | { status: "deduped" }
  | { status: "nobody" };

const TITLES: Record<LeadOnlyHandoverReason, string> = {
  hot: "🔥 Клиент готов смотреть, бот передал вам",
  escalate: "Клиент ждёт ответа сотрудника",
  filtered: "Клиент ждёт ответа сотрудника",
  intake_failed: "⚠️ Заявка из переписки не оформилась",
  no_agent: "⚠️ Бот обещал звонок, а агента у заявки нет",
};

export function leadOnlyHandoverTag(conversationId: string): string {
  return `lead-only-handover-${conversationId}`;
}

/**
 * Позвать человека к диалогу. `summary` — суть для хронологии карточки (там права карточки),
 * в пуш она не попадает. Бросает только при сбое базы; отказ доставки пуша глотается в журнал.
 */
export async function notifyLeadOnlyHandover(input: { conversationId: string; propertyId: string | null;
  reason: LeadOnlyHandoverReason; summary: string; force?: boolean }): Promise<LeadOnlyHandoverResult> {
  const tag = leadOnlyHandoverTag(input.conversationId);
  // Сбой заявки — всегда: это не повтор того же повода, а новая беда.
  const urgent = input.reason === "intake_failed" || input.reason === "no_agent" || input.force === true;
  if (!urgent && !(await shouldAlert(tag, LEAD_ONLY_HANDOVER_INTERVAL_MS))) return { status: "deduped" };
  const conversation = await prisma.botConversation.findUnique({ where: { id: input.conversationId },
    select: { id: true, channel: true, client: { select: { id: true, shortId: true, fullName: true, assignedAgentId: true,
      agentAttentionRequestedAt: true, deletedAt: true } } } });
  if (!conversation) return { status: "nobody" };
  const title = TITLES[input.reason];
  const chatUrl = `/messages?open=${conversation.id}`;
  const client = conversation.client && !conversation.client.deletedAt ? conversation.client : null;

  if (client?.assignedAgentId) {
    const agentId = client.assignedAgentId;
    if (!client.agentAttentionRequestedAt) {
      await prisma.client.updateMany({ where: { id: client.id, agentAttentionRequestedAt: null }, data: { agentAttentionRequestedAt: new Date() } });
    }
    await logTimeline({ clientId: client.id, actor: { kind: "client", source: "lead-only-handover", subjectAgentId: agentId },
      type: "SYSTEM", notes: `Бот передал клиента агенту: ${input.summary}` })
      .catch((err) => console.error("[режим только заявки] хронология:", describeError(err)));
    await deliver([agentId], { kind: "message", level: "CRITICAL", title, body: `${client.fullName}: клиент ждёт вас. Откройте карточку.`,
      url: `/clients/${client.shortId}`, tag });
    return { status: "notified", to: "assigned", recipients: 1 };
  }

  const owners = new Set<string>();
  if (input.propertyId) {
    const property = await prisma.property.findUnique({ where: { id: input.propertyId },
      select: { intakeAgentId: true, assignedAgentId: true, createdById: true, deletedAt: true } });
    const owner = property && !property.deletedAt ? propertyOwnerAgentId(property) : null;
    if (owner) owners.add(owner);
  }
  if (!owners.size) for (const id of await propertyInterestChatAgentIds(conversation.id)) owners.add(id);
  const activeOwners = owners.size
    ? (await prisma.agent.findMany({ where: { id: { in: [...owners] }, isActive: true }, select: { id: true } })).map(a => a.id)
    : [];
  const body = "Клиент написал боту и ждёт ответа сотрудника. Откройте переписку.";
  if (activeOwners.length) {
    await deliver(activeOwners, { kind: "message", level: "CRITICAL", title, body, url: chatUrl, tag });
    return { status: "notified", to: "property", recipients: activeOwners.length };
  }
  const supervisors = await findAgentsWithPermission("clients.assign");
  if (supervisors.length) {
    await deliver(supervisors, { kind: "message", level: "CRITICAL", title, body, url: chatUrl, tag });
    return { status: "notified", to: "supervisors", recipients: supervisors.length };
  }
  void logSystemError("ai", `[alarm] Режим «только заявки»: бот передал клиента человеку, но звать некого (диалог ${conversation.id}). ` +
    "Откройте переписку и ответьте клиенту.", { dedupKey: `lead-only-handover-nobody:${conversation.id}` });
  return { status: "nobody" };
}

async function deliver(agentIds: string[], payload: Parameters<typeof sendPushToAgents>[1]): Promise<void> {
  try {
    if (agentIds.length === 1) await sendPushToAgent(agentIds[0], payload);
    else await sendPushToAgents(agentIds, payload);
  } catch (err) {
    // Запись в ленте пишется до доставки на устройство; отказ доставки виден в журнале.
    void logSystemError("api", `Режим «только заявки»: пуш о передаче клиента не доставлен: ${describeError(err)}`,
      { dedupKey: "lead-only-handover-push" });
  }
}
