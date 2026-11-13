/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ»: «ПЕРЕДАЮ АГЕНТУ» ЗНАЧИТ, ЧТО ЧЕЛОВЕК ПРАВДА УЗНАЛ (ревью 13.11.2026).
 *
 * Бот говорит клиенту «передаю агенту» в нескольких случаях: горячие слова («хотим посмотреть»,
 * «куда ехать»), понравившийся объект без номера, вопрос, который модель решила отдать сотруднику,
 * и ответ, из которого фильтр вырезал подборку или ссылку.
 *
 * Здесь одна дверь на оба маршрута бота (ядро — из задания lib/customerLeadOnlyCore.ts, старый путь —
 * из messengers/conversation.ts). Кому:
 *  1. карточка есть и у неё ДЕЙСТВУЮЩИЙ агент — ему: пуш, запись в хронологии и метка «просит агента»
 *     (Client.agentAttentionRequestedAt). Если разговор об объекте другого агента, хозяину объекта —
 *     короткая заметка без контактов клиента: «клиент интересуется вашим объектом №N, ведёт агент X»
 *     (решение по умолчанию до ответа владельца, второе ревью 13.11);
 *  2. иначе (карточки нет, агента нет или он уволен/отключён — второе ревью, №5) — агент объекта
 *     (объект этого хода, иначе объекты переписки), пуш со ссылкой на чат;
 *  3. иначе руководители, раздающие заявки (право clients.assign), — пуш со ссылкой на чат.
 * Никого нет — тревога в журнал ошибок: обещание клиенту без адресата должно быть видно.
 *
 * «Редко беспокоить людей» (владелец 10.11), но не терять горячего клиента (второе ревью, №4):
 * у каждого повода своё окно тишины на диалог. Прежнее одно окно на диалог глушило горячие слова,
 * если шестью часами раньше ушла заметка о вопросе к сотруднику. Горячие слова зовут всегда; гасится
 * только тот же самый горячий повод в течение нескольких минут (повтор задания, склейка сообщений).
 * В тексте пуша нет ни номера, ни слов клиента: экран открывается по правам сотрудника.
 */
import { createHash } from "node:crypto";
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
/** Тот же горячий повод (повтор задания, склейка) — не чаще раза в 10 минут; другой горячий — сразу. */
export const LEAD_ONLY_HOT_REPEAT_MS = 10 * 60_000;

export type LeadOnlyHandoverReason = "hot" | "property" | "escalate" | "filtered" | "new_phone" | "intake_failed" | "no_agent";
export type LeadOnlyHandoverResult =
  | { status: "notified"; to: "assigned" | "property" | "supervisors"; recipients: number }
  | { status: "deduped" }
  | { status: "nobody" };

const TITLES: Record<LeadOnlyHandoverReason, string> = {
  hot: "🔥 Клиент готов смотреть, бот передал вам",
  property: "Клиент интересуется вашим объектом",
  escalate: "Клиент ждёт ответа сотрудника",
  filtered: "Клиент ждёт ответа сотрудника",
  new_phone: "Клиент просит звонить на другой номер",
  intake_failed: "⚠️ Заявка из переписки не оформилась",
  no_agent: "⚠️ Бот обещал звонок, а агента у заявки нет",
};

/** Начало метки всех уведомлений режима по диалогу (для поиска и уборки). */
export function leadOnlyHandoverTag(conversationId: string): string {
  return `lead-only-handover-${conversationId}`;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/** Метка окна тишины: свой повод — своё окно. `key` уточняет повод (новый номер — свой ключ на номер). */
function reasonTag(conversationId: string, reason: LeadOnlyHandoverReason, summary: string, key?: string): string {
  const base = `${leadOnlyHandoverTag(conversationId)}:${reason}`;
  if (reason === "hot") return `${base}:${digest(summary)}`;
  return key ? `${base}:${digest(key)}` : base;
}

/**
 * Позвать человека к диалогу. `summary` — суть для хронологии карточки (там права карточки),
 * в пуш она не попадает. `key` — уточнение повода для окна тишины (например, сам новый номер).
 * Бросает только при сбое базы; отказ доставки пуша глотается в журнал.
 */
export async function notifyLeadOnlyHandover(input: { conversationId: string; propertyId: string | null;
  reason: LeadOnlyHandoverReason; summary: string; key?: string }): Promise<LeadOnlyHandoverResult> {
  const tag = reasonTag(input.conversationId, input.reason, input.summary, input.key);
  // Сбой заявки — всегда: это не повтор того же повода, а новая беда.
  const urgent = input.reason === "intake_failed" || input.reason === "no_agent";
  const window = input.reason === "hot" ? LEAD_ONLY_HOT_REPEAT_MS : LEAD_ONLY_HANDOVER_INTERVAL_MS;
  if (!urgent && !(await shouldAlert(tag, window))) return { status: "deduped" };
  const conversation = await prisma.botConversation.findUnique({ where: { id: input.conversationId },
    select: { id: true, channel: true, client: { select: { id: true, shortId: true, fullName: true, assignedAgentId: true,
      agentAttentionRequestedAt: true, deletedAt: true } } } });
  if (!conversation) return { status: "nobody" };
  const title = TITLES[input.reason];
  const chatUrl = `/messages?open=${conversation.id}`;
  const client = conversation.client && !conversation.client.deletedAt ? conversation.client : null;
  const property = input.propertyId ? await prisma.property.findUnique({ where: { id: input.propertyId },
    select: { shortId: true, intakeAgentId: true, assignedAgentId: true, createdById: true, deletedAt: true } }) : null;
  const propertyOwner = property && !property.deletedAt ? propertyOwnerAgentId(property) : null;

  // Уволенный или отключённый агент карточки пуш не прочтёт: такой клиент зовёт хозяина объекта и руководителей.
  const cardAgent = client?.assignedAgentId ? await prisma.agent.findFirst({ where: { id: client.assignedAgentId, isActive: true },
    select: { id: true, fullName: true } }) : null;
  if (client && cardAgent) {
    if (!client.agentAttentionRequestedAt) {
      await prisma.client.updateMany({ where: { id: client.id, agentAttentionRequestedAt: null }, data: { agentAttentionRequestedAt: new Date() } });
    }
    await logTimeline({ clientId: client.id, actor: { kind: "client", source: "lead-only-handover", subjectAgentId: cardAgent.id },
      type: "SYSTEM", notes: `Бот передал клиента агенту: ${input.summary}` })
      .catch((err) => console.error("[режим только заявки] хронология:", describeError(err)));
    await deliver([cardAgent.id], { kind: "message", level: "CRITICAL", title, body: `${client.fullName}: клиент ждёт вас. Откройте карточку.`,
      url: `/clients/${client.shortId}`, tag });
    // Клиент уже чей-то, а объект — другого агента: хозяину объекта короткая заметка без контактов клиента.
    if (property && propertyOwner && propertyOwner !== cardAgent.id &&
        await prisma.agent.count({ where: { id: propertyOwner, isActive: true } })) {
      await deliver([propertyOwner], { kind: "message", level: "OTHER", title: `Клиент интересуется вашим объектом №${property.shortId}`,
        body: `Клиента ведёт агент ${cardAgent.fullName}. Если нужно, договоритесь с ним.`, url: `/properties/${property.shortId}`,
        tag: `${tag}:owner` });
    }
    return { status: "notified", to: "assigned", recipients: 1 };
  }

  const owners = new Set<string>();
  if (propertyOwner) owners.add(propertyOwner);
  if (!owners.size) for (const id of await propertyInterestChatAgentIds(conversation.id)) owners.add(id);
  const activeOwners = owners.size
    ? (await prisma.agent.findMany({ where: { id: { in: [...owners] }, isActive: true }, select: { id: true } })).map(a => a.id)
    : [];
  const body = property
    ? `Клиент написал боту про объект №${property.shortId} и ждёт ответа. Откройте переписку.`
    : "Клиент написал боту и ждёт ответа сотрудника. Откройте переписку.";
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

/** Позван ли уже человек по этому диалогу за окно тишины (любой повод): ответ клиенту «агент уже в курсе» правдив. */
export async function leadOnlyHumanNotifiedRecently(conversationId: string, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - LEAD_ONLY_HANDOVER_INTERVAL_MS);
  return (await prisma.notification.count({ where: { tag: { startsWith: `${leadOnlyHandoverTag(conversationId)}:` }, createdAt: { gte: since } } })) > 0;
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
