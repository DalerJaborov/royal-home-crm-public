import { prisma } from "../db.js";
import { propertyInterestChatAgentIds } from "./ownBotConversationScope.js";
import { publish, liveEventsEnabled, MESSAGES_VIEW_ADDRESSING_MARK } from "./eventBus.js";
import { dropMissionControlSections, registerPultSnapshotPublisher } from "./pultCacheHook.js";

/**
 * ТОЧКИ ПУБЛИКАЦИИ ЖИВЫХ СОБЫТИЙ — одно место на всю CRM (12.09.2026).
 *
 * Тонкие обёртки над publish() из lib/eventBus.ts. Вынесены отдельно по правилу
 * «починил в одном месте — ищи ВЕСЬ класс»: адресация (кому видно) и набор
 * идентификаторов должны быть одинаковыми во всех точках, а их десятки. Здесь
 * же живёт единственное знание о том, кто кроме исполнителя видит чужую
 * карточку.
 *
 * Все функции — fire-and-forget: `void publishX(...)`. Ни одна бизнес-операция
 * не должна упасть или замедлиться из-за того, что не доехало уведомление об
 * обновлении. Звать их полагается ПОСЛЕ успешного коммита: событие, пережившее
 * откат, отправило бы браузер за данными, которых нет.
 */

/**
 * Роли, которым в пресетах выдан clients.viewAll (packages/shared/permissions.ts).
 *
 * Точечные надбавки прав отдельному сотруднику здесь НЕ учитываются, и это
 * сознательно. Событие не несёт данных — только «сходи перезапроси», — поэтому
 * лишний адресат не видит ничего лишнего (роут отдаст ему ровно то, на что у
 * него есть право), а недостающий адресат теряет не данные, а секунды: его
 * экран обновится запасным путём, опросом по таймеру. Читать права каждого
 * подписчика на каждое сообщение было бы дороже пользы.
 *
 * ИСКЛЮЧЕНИЕ (находка ночной проверки 24.09.2026, №245/К2-3): для двух
 * чат-событий ниже (publishMessageNew, publishConversationUpdated) точечная
 * надбавка messages.view сверх пресета AGENT всё же учитывается — но не
 * чтением прав на каждое сообщение, а меткой MESSAGES_VIEW_ADDRESSING_MARK
 * (eventBus.ts): подписчик сам знает своё право, вычисленное ОДИН раз при
 * открытии потока (routes/events.ts), и сверяет с меткой сам. Без надбавки
 * такой сотрудник не входит ни в OVERSEER_ROLES, ни в исполнителя диалога —
 * и живые события ему не адресовались вовсе, только опрос раз в 5 минут.
 */
// HEAD_OF_SALES и SHAREHOLDER смотрят экраны живьём (спека ролей §1.4); уведомлений акционеру нет.
export const OVERSEER_ROLES = ["DIRECTOR", "ADMIN", "MANAGER", "SECURITY", "HEAD_OF_SALES", "SHAREHOLDER"] as const;

/**
 * Звонок изменился: входящий появился, принят, пропущен либо разобран.
 *
 * Адресация: исполнитель клиента (если звонок уже связан с карточкой) плюс
 * надзор. Журнал входящих и лента звонков — экраны надзора, поэтому ролей
 * достаточно; рядовой агент увидит свой звонок через agentIds.
 */
export function publishCallUpdated(input: {
  callId: string;
  clientId?: string | null;
  agentId?: string | null;
}): void {
  dropMissionControlSections("all");
  void publish({
    type: "call.updated",
    payload: {
      callId: input.callId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
    },
    agentIds: input.agentId ? [input.agentId] : [],
    roles: [...OVERSEER_ROLES],
  });
}

/**
 * Клиент изменился так, что это видно ЧУЖИМ экранам: исполнитель, статус,
 * возврат в работу, отказ, отложенные.
 *
 * `agentIds` — оба исполнителя: и новый, и прежний. При передаче клиента
 * прежний обязан увидеть, что карточка из его списка ушла, иначе он будет
 * работать по ней ещё пять минут (ровно тот разрыв, ради которого 12.09
 * события вообще завели).
 *
 * Мелкие правки карточки (комментарий, бюджет) сюда НЕ публикуются: их видит
 * тот же человек, который их и сделал, а его экран обновляет мутация.
 */
export function publishClientUpdated(input: {
  clientId: string;
  agentIds?: (string | null | undefined)[];
  stage?: string | null;
  actorId?: string | null;
}): void {
  dropMissionControlSections("all");
  void publish({
    type: "client.updated",
    payload: {
      clientId: input.clientId,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
    },
    agentIds: uniqueIds(input.agentIds),
    roles: [...OVERSEER_ROLES],
  });
}

/** Объект создан, изменён, опубликован/снят или отправлен в корзину. */
export function publishPropertyUpdated(input: {
  propertyId: string;
  agentId?: string | null;
  stage?: string | null;
  actorId?: string | null;
}): void {
  dropMissionControlSections("all");
  void publish({
    type: "property.updated",
    payload: {
      propertyId: input.propertyId,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
    },
    agentIds: input.agentId ? [input.agentId] : [],
    roles: [...OVERSEER_ROLES],
  });
}

/**
 * Заявка на рассмотрение изменилась: удаление клиента, удаление объекта, спор
 * о количестве объектов — создана, одобрена или отклонена.
 *
 * `stage` несёт состояние заявки короткой строкой (PENDING/APPROVED/REJECTED):
 * это признак, а не текст, содержимого в потоке по-прежнему нет.
 */
export function publishRequestUpdated(input: {
  requestId: string;
  clientId?: string | null;
  propertyId?: string | null;
  agentIds?: (string | null | undefined)[];
  stage?: string | null;
  actorId?: string | null;
}): void {
  dropMissionControlSections("all");
  void publish({
    type: "request.updated",
    payload: {
      requestId: input.requestId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
    },
    agentIds: uniqueIds(input.agentIds),
    roles: [...OVERSEER_ROLES],
  });
}

/** Отсеять пустое и повторы: в адресаты часто идут «новый и прежний» исполнители. */
function uniqueIds(ids: (string | null | undefined)[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Где лежит история диалога: три таблицы, одинаковые по смыслу. */
export type ConversationKind = "bot" | "telegram" | "telegram-direct";

/** Новый лид предложен сотруднику и ждёт принятия. */
export function publishLeadPending(clientId: string, agentId: string | null | undefined): void {
  dropMissionControlSections("all");
  void publish({
    type: "lead.pending",
    payload: { clientId },
    agentIds: agentId ? [agentId] : [],
    roles: [...OVERSEER_ROLES],
  });
}

/** Лид принят: предложение обязано погаснуть у всех, кому его показывали. */
export function publishLeadAccepted(clientId: string, agentId: string): void {
  dropMissionControlSections("all");
  void publish({
    type: "lead.accepted",
    payload: { clientId, actorId: agentId },
    agentIds: [agentId],
    roles: [...OVERSEER_ROLES],
  });
}

/**
 * Новое сообщение в диалоге.
 *
 * Зовётся из ЕДИНСТВЕННЫХ мест записи истории (messengers/appendMessages.ts и
 * telegramDirectMessages.ts) — там же, где jsonb-конкатенация. Так событие
 * покрывает разом все ~20 мест, которые дописывают реплики: и входящее от
 * клиента, и ответ бота, и ручной ответ сотрудника. Ставить publish в каждое из
 * них значило бы гарантированно разойтись с реальностью на следующей неделе.
 *
 * Цена — один короткий запрос за clientId/assignedAgentId на дописанную пачку
 * реплик (не на реплику). Диалоги идут в темпе живых людей, это не горячий путь.
 */
export async function publishMessageNew(
  kind: ConversationKind,
  conversationId: string,
  direction: "IN" | "OUT"
): Promise<void> {
  if (!liveEventsEnabled()) return;
  try {
    const link = await loadConversationLink(kind, conversationId);
    dropMissionControlSections("live");
    await publish({
      type: "message.new",
      payload: {
        conversationId,
        direction,
        ...(link?.clientId ? { clientId: link.clientId } : {}),
        ...(link?.channel ? { channel: link.channel } : {}),
      },
      agentIds: link?.assignedAgentId ? [link.assignedAgentId] : kind === "bot" ? await propertyInterestChatAgentIds(conversationId) : [],
      roles: [...OVERSEER_ROLES, MESSAGES_VIEW_ADDRESSING_MARK],
    });
  } catch {
    // Молча: история уже записана, а живость — удобство поверх опроса.
  }
}

/** Диалог изменился не текстом: прочитан, поставлен на паузу, вернулся боту. */
export async function publishConversationUpdated(kind: ConversationKind, conversationId: string): Promise<void> {
  if (!liveEventsEnabled()) return;
  try {
    const link = await loadConversationLink(kind, conversationId);
    dropMissionControlSections("live");
    await publish({
      type: "conversation.updated",
      payload: {
        conversationId,
        ...(link?.clientId ? { clientId: link.clientId } : {}),
        ...(link?.channel ? { channel: link.channel } : {}),
      },
      agentIds: link?.assignedAgentId ? [link.assignedAgentId] : kind === "bot" ? await propertyInterestChatAgentIds(conversationId) : [],
      roles: [...OVERSEER_ROLES, MESSAGES_VIEW_ADDRESSING_MARK],
    });
  } catch {
    /* см. выше */
  }
}

/** Сделка изменилась (в первую очередь стадия). */
export function publishDealUpdated(input: {
  dealId: string;
  clientId?: string | null;
  agentId?: string | null;
  stage?: string | null;
  actorId?: string | null;
}): void {
  dropMissionControlSections("all");
  void publish({
    type: "deal.updated",
    payload: {
      dealId: input.dealId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
    },
    agentIds: input.agentId ? [input.agentId] : [],
    roles: [...OVERSEER_ROLES],
  });
}

/**
 * Снимок пульта пересчитан.
 *
 * Широковещательное (ни agentIds, ни roles): пульт открыт у всех, а сами
 * секции каждый получает своим запросом со своими правами.
 */
/**
 * Не чаще раза в PULT_SNAPSHOT_MIN_GAP_MS на процесс: источники (ошибка в
 * журнале, сообщение клиента, смена статуса ролика, комментарий IG, запрос
 * «перезвоните») бывают пачками, а каждое событие — волна перезапросов у всех
 * открытых пультов. Лишние вызовы не теряются: один отложенный выстрел в
 * конце окна (trailing), чтобы последнее изменение обязательно дошло. Кэш
 * секций сбрасывается на КАЖДЫЙ вызов (дёшево, без publish) — перезапрос по
 * любому событию не получит устаревший снимок.
 */
export const PULT_SNAPSHOT_MIN_GAP_MS = 5_000;
let pultSnapshotLastAt = 0;
let pultSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

function emitPultSnapshot(): void {
  pultSnapshotLastAt = Date.now();
  void publish({ type: "pult.snapshot", payload: {}, roles: [...OVERSEER_ROLES] });
}

export function publishPultSnapshot(): void {
  // Источники снимка (ошибки, ролики, комментарии, «перезвоните») лежат в зонах
  // пульта (TTL 60 с), а не только в живых секциях — сбрасываем всё.
  dropMissionControlSections("all");
  const wait = pultSnapshotLastAt + PULT_SNAPSHOT_MIN_GAP_MS - Date.now();
  if (wait <= 0) {
    if (pultSnapshotTimer) {
      clearTimeout(pultSnapshotTimer);
      pultSnapshotTimer = null;
    }
    emitPultSnapshot();
    return;
  }
  if (pultSnapshotTimer) return;
  pultSnapshotTimer = setTimeout(() => {
    pultSnapshotTimer = null;
    emitPultSnapshot();
  }, wait);
  pultSnapshotTimer.unref?.();
}

registerPultSnapshotPublisher(publishPultSnapshot);

/** Только для тестов: сбросить окно троттла. */
export function __resetPultSnapshotThrottleForTests(): void {
  pultSnapshotLastAt = 0;
  if (pultSnapshotTimer) clearTimeout(pultSnapshotTimer);
  pultSnapshotTimer = null;
}

/** Создано уведомление для перечисленных сотрудников. */
export function publishNotificationNew(agentIds: string[], notificationId?: string): void {
  const ids = agentIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return;
  void publish({
    type: "notification.new",
    payload: notificationId ? { notificationId } : {},
    agentIds: ids,
  });
}

/** Кому виден диалог: клиент и его исполнитель. Одна короткая выборка на три таблицы. */
async function loadConversationLink(
  kind: ConversationKind,
  conversationId: string
): Promise<{ clientId: string | null; assignedAgentId: string | null; channel: string | null } | null> {
  if (kind === "bot") {
    const row = await prisma.botConversation.findUnique({
      where: { id: conversationId },
      select: { clientId: true, channel: true, client: { select: { assignedAgentId: true } } },
    });
    return row ? { clientId: row.clientId, assignedAgentId: row.client?.assignedAgentId ?? null, channel: row.channel } : null;
  }
  if (kind === "telegram") {
    const row = await prisma.telegramConversation.findUnique({
      where: { id: conversationId },
      select: { clientId: true, client: { select: { assignedAgentId: true } } },
    });
    return row ? { clientId: row.clientId, assignedAgentId: row.client?.assignedAgentId ?? null, channel: "TELEGRAM" } : null;
  }
  const row = await prisma.telegramDirectConversation.findUnique({
    where: { id: conversationId },
    select: { clientId: true, client: { select: { assignedAgentId: true } } },
  });
  return row ? { clientId: row.clientId, assignedAgentId: row.client?.assignedAgentId ?? null, channel: "TELEGRAM" } : null;
}
