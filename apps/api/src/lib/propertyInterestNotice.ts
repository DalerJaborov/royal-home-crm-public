import { channelLabel } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { logTimeline } from "./timeline.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { findAgentsWithPermission } from "./recipients.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { sendLeadPush } from "./pushLeadActions.js";
import { loadCustomerTransportForConversation, resolveCustomerEndpoint, type CustomerTransportEndpoint, type CustomerTransportReference } from "./customerConversationScope.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { closeOwnershipSatellites } from "./ownershipSatellites.js";
import { runClientAutopilotInBackground } from "./clientAutopilot.js";

/** Local relation witness, NOT customer identity or a private ACL. By-ID callers
 * already select an authorized native resource; public ASIDs must not mint it. */
export interface ConversationInterestWitness {
  conversationId: string; inquiryId: string; endpointScopeId: string;
  channel: string; subscriberId: string; accountId: string | null;
  clientId: string | null; contactProfileId: string | null;
  bindingRevision: string; ownershipEpoch: string; scopeRevision: string;
  scopeKind: string; transport?: CustomerTransportReference;
}

export async function readConversationInterestWitness(conversationId: string, db: TxClient = prisma): Promise<ConversationInterestWitness | null> {
  const rows = await db.$queryRaw<ConversationInterestWitness[]>`
    SELECT c."id" AS "conversationId", i."id" AS "inquiryId", c."endpointScopeId", c."channel", c."subscriberId", c."accountId",
      c."clientId", c."contactProfileId", i."bindingRevision"::text, i."ownershipEpoch"::text,
      s."scopeRevision"::text, s."kind" AS "scopeKind"
    FROM "BotConversation" c JOIN "CustomerInquiry" i ON i."conversationId"=c."id"
      JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId"
    WHERE c."id"=${conversationId} AND i."closedAt" IS NULL
      AND i."endpointScopeId"=c."endpointScopeId" AND i."peerId"=c."subscriberId" AND i."threadId"=''
      AND s."channel"=c."channel" AND s."messengerAccountId" IS NOT DISTINCT FROM c."accountId"`;
  if (rows.length !== 1) return null;
  const witness = rows[0];
  if (witness.scopeKind === "NORMAL") {
    const transport = await loadCustomerTransportForConversation(conversationId, db);
    if (!transport || transport.endpointScopeId !== witness.endpointScopeId || transport.channel !== witness.channel ||
      transport.accountId !== witness.accountId || transport.scopeRevision !== witness.scopeRevision) return null;
    return { ...witness, transport };
  }
  // Legacy by-ID staff service remains usable. No legacy row may be selected
  // by a channel/ASID alias or treated as an installed private endpoint.
  return witness.scopeKind === "LEGACY_UNKNOWN" ? witness : null;
}

export async function readScopedConversationInterestWitness(input: CustomerTransportEndpoint): Promise<ConversationInterestWitness | null> {
  const endpoint = await resolveCustomerEndpoint(input);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "BotConversation" WHERE "endpointScopeId"=${endpoint.endpointScopeId}
      AND "channel"=${endpoint.channel} AND "subscriberId"=${endpoint.subscriberId}
      AND "accountId" IS NOT DISTINCT FROM ${endpoint.accountId}`;
  if (rows.length !== 1) return null;
  const witness = await readConversationInterestWitness(rows[0].id);
  return witness && witness.endpointScopeId === endpoint.endpointScopeId && witness.channel === endpoint.channel &&
    witness.subscriberId === endpoint.subscriberId && witness.accountId === endpoint.accountId &&
    witness.scopeRevision === endpoint.scopeRevision ? witness : null;
}

/** Native-first order matches native UPDATE → inquiry triggers. All local
 * mutations use this SAME tx; no provider/notification work under these locks. */
export async function lockConversationInterestWitness(tx: TxClient, witness: ConversationInterestWitness): Promise<boolean> {
  if (!await lockCustomerNative(tx, { kind: "bot", id: witness.conversationId })) return false;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT i."id" FROM "BotConversation" c JOIN "CustomerInquiry" i ON i."conversationId"=c."id"
      JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId"
    WHERE c."id"=${witness.conversationId} AND i."id"=${witness.inquiryId} AND i."closedAt" IS NULL
      AND c."endpointScopeId"=${witness.endpointScopeId} AND i."endpointScopeId"=c."endpointScopeId"
      AND c."channel"=${witness.channel} AND c."subscriberId"=${witness.subscriberId}
      AND i."peerId"=c."subscriberId" AND i."threadId"=''
      AND c."accountId" IS NOT DISTINCT FROM ${witness.accountId}
      AND c."clientId" IS NOT DISTINCT FROM ${witness.clientId}
      AND c."contactProfileId" IS NOT DISTINCT FROM ${witness.contactProfileId}
      AND i."bindingRevision"=${BigInt(witness.bindingRevision)} AND i."ownershipEpoch"=${BigInt(witness.ownershipEpoch)}
      AND s."channel"=c."channel" AND s."messengerAccountId" IS NOT DISTINCT FROM c."accountId"
      AND s."kind"=${witness.scopeKind} AND s."scopeRevision"=${BigInt(witness.scopeRevision)}
    FOR UPDATE OF i FOR SHARE OF s`;
  if (rows.length !== 1) return false;
  if (witness.transport) await resolveCustomerEndpoint({ channel: witness.channel, subscriberId: witness.subscriberId, transport: witness.transport }, tx);
  return true;
}

async function witnessCurrent(witness: ConversationInterestWitness): Promise<boolean> {
  return prisma.$transaction(tx => lockConversationInterestWitness(tx, witness));
}

async function ownerNoticeCurrent(propertyId: string, ownerId: string, ownerActive: boolean, witness?: ConversationInterestWitness): Promise<boolean> {
  const property = await liveProperty(propertyId);
  if (!property || propertyOwnerAgentId(property) !== ownerId) return false;
  const owner = await prisma.agent.findUnique({ where: { id: ownerId }, select: { isActive: true } });
  if (!!owner?.isActive !== ownerActive) return false;
  return !witness || await witnessCurrent(witness);
}

/**
 * КЛИЕНТ АГЕНТА А ИНТЕРЕСУЕТСЯ ОБЪЕКТОМ АГЕНТА Б (решение Dan 02.10.2026,
 * «Сообщить обоим»). Раздача срабатывает только на НОВОМ лиде: закреплённый
 * клиент, переславший пост, скриншот или назвавший номер чужого объекта, оставался
 * у своего агента, а агент объекта не узнавал о нём никогда.
 *
 * Карточка НЕ переезжает — клиент не теряет своего агента. Агенту объекта уходит
 * пуш (без контактов клиента: у него нет доступа к чужой карточке), в хронологии
 * клиента остаётся запись — её видит агент А.
 *
 * Один раз в сутки на пару «клиент + объект»: клиент, пересылающий один пост пять
 * раз, не должен будить агента пять раз. Проверка по базе, а не в памяти — иначе
 * перезапуск сервера снова разбудил бы.
 */

const DEDUP_MS = 24 * 60 * 60 * 1000;
const SOURCE = "property-interest-other-agent";

/** Объект в продаже, по которому можно звать хозяина: проданный и снятый — нет (02.10.2026). */
async function liveProperty(propertyId: string, db: TxClient = prisma) {
  return db.property.findFirst({
    where: { id: propertyId, deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
    select: { id: true, shortId: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
}

export async function noticeInterestInOtherAgentProperty(input: {
  clientId: string;
  propertyId: string;
  witness?: ConversationInterestWitness;
}): Promise<void> {
  try {
    const notice = await prisma.$transaction(async tx => {
      if (input.witness && input.witness.clientId !== input.clientId) return null;
      // Serialize the dedup/timeline with client deletion or reassignment. The
      // legacy Client UPDATE locks Client before its Inquiry trigger. Match
      // Client → native → Inquiry order, then recheck the captured relation.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Client" WHERE "id"=${input.clientId} FOR UPDATE`;
      if (locked.length !== 1) return null;
      if (input.witness && !await lockConversationInterestWitness(tx, input.witness)) return null;
      const [client, property] = await Promise.all([
        tx.client.findUnique({
          where: { id: input.clientId },
          select: { id: true, assignedAgentId: true, deletedAt: true },
        }),
        liveProperty(input.propertyId, tx),
      ]);
      if (!client || client.deletedAt || !client.assignedAgentId || !property) return null;
      const ownerId = propertyOwnerAgentId(property);
      if (!ownerId || ownerId === client.assignedAgentId) return null;
      const owner = await tx.agent.findUnique({ where: { id: ownerId }, select: { isActive: true } });
      if (!owner?.isActive) return null;

      const recent = await tx.interaction.findFirst({
        where: {
          clientId: client.id,
          propertyId: property.id,
          subjectAgentId: ownerId,
          createdAt: { gte: new Date(Date.now() - DEDUP_MS) },
        },
        select: { id: true },
      });
      if (recent) return null;

      await logTimeline({
        clientId: client.id,
        actor: { kind: "client", source: SOURCE, subjectAgentId: ownerId },
        type: "SYSTEM",
        propertyId: property.id,
        notes: `Клиент интересуется объектом №${property.shortId} — требуется согласование с агентом объекта.`,
        tx,
      });
      return { ownerId, clientId: client.id, propertyId: property.id, shortId: property.shortId };
    });
    if (!notice || !await ownerNoticeCurrent(notice.propertyId, notice.ownerId, true, input.witness)) return;
    void sendPushToAgent(notice.ownerId, {
      title: "👀 Интерес к вашему объекту",
      body: `Клиент другого агента интересуется вашим объектом №${notice.shortId}. Согласуйте дальнейшую работу с агентом клиента в CRM.`,
      url: `/properties/${notice.shortId}`,
      tag: `interest-${notice.clientId}-${notice.propertyId}`,
    }).catch((err) => console.error("[push] интерес к объекту другого агента:", err));
  } catch (err) {
    void logSystemError("api", `Уведомление агенту объекта не отправлено: ${describeError(err)}`);
  }
}

/** Legacy caller is PUBLIC comments: author ASID is not private DM identity.
 * COMMENT/CLIENT_SHARED aggregate evidence remains recorded by sharedMedia;
 * private Client/timeline/queue side effects require a server-selected native ID. */
export async function noticeInterestByConversation(input: {
  channel: string;
  recipientId: string;
  propertyId: string;
  accountId?: string | null;
}): Promise<void> {
  void input;
}

/**
 * P0-7 АУДИТА 10.10.2026 — РЕШЕНИЕ ВЛАДЕЛЬЦА, ОДИН ФЛАГ (по умолчанию — как сейчас).
 *
 * Клиент уже закреплён за агентом Б (лид из очереди, даже минуту назад) и пишет
 * по объекту агента А. Закон о владении (docs/law/lead-ownership.md, П-3/П-4)
 * разрешает автопередачу только ДО контакта, а требование «клиент по объекту —
 * всегда хозяину» с ним расходится. Варианты:
 *
 *  (б) — ПО УМОЛЧАНИЮ: лид не переезжает никогда; хозяин объекта ВСЕГДА получает
 *      уведомление (для клиента без карточки и без номера — тоже, со ссылкой на
 *      переписку). Эта часть безусловна и от флага не зависит.
 *  (а) — `OBJECT_INTEREST_PULLS_QUEUE_LEAD=1` в окружении сервера: НЕпринятый лид,
 *      выданный ОЧЕРЕДЬЮ (`assignReason` пуст или «queue», `acceptedAt` пуст),
 *      переезжает к хозяину объекта; принятый, названный клиентом или отданный по
 *      другому объекту — остаётся, хозяину уходит уведомление (б).
 *
 * Флаг — переменная окружения, а не поле Настроек: поле требовало бы миграции
 * схемы ради решения, которого ещё нет.
 */
export function objectInterestPullsQueueLead(): boolean {
  return process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD === "1";
}

const ANON_SOURCE = "property-interest-conversation";
/** Уведомления в полёте: два узнавания одного объекта в одной пачке сообщений
 *  не должны оба пройти проверку «в ленте ещё нет» и разбудить хозяина дважды. */
const inFlight = new Set<string>();

/**
 * ХОЗЯИН ОБЪЕКТА УЗНАЁТ О ПЕРЕПИСКЕ ВСЕГДА (10.10.2026, аудит
 * docs/audit-bots-2026-10-10-object-routing.md, P0-3, и безусловная часть P0-7).
 *
 * До этой правки хозяину уходил пуш, только если у клиента УЖЕ была карточка
 * другого агента. А 47 из 66 переписок недели, где объект узнан (пост, реклама,
 * ссылка, номер), карточки не получили вовсе: клиент не дал номер, и хозяин о
 * разговоре не знал. Теперь узнанный объект в переписке будит хозяина в любом
 * случае, кроме одного — клиент уже его.
 *
 * Без персональных данных: ни имени, ни номера собеседника — только объект, канал
 * и ссылка на переписку в «Чатах». Один раз в сутки на пару «переписка + объект»
 * (по ленте уведомлений хозяина, а не по памяти процесса — переживает перезапуск).
 * Хозяин уволен или отключён — тот же сигнал руководителю: «по объекту пишут, а
 * хозяина нет» (P0-6).
 *
 * Зовётся из единой точки «код узнал объект в диалоге»
 * (lib/propertyVoice/linkConversation.ts) — для пересланного поста, ссылки,
 * рекламы и номера в тексте разом. Показ объекта ботом (EXPOSURE) интересом
 * клиента не считается и сюда не приходит. Никогда не бросает.
 */
export async function noticeOwnerOfConversationInterest(input: {
  conversationId: string;
  propertyId: string;
  witness?: ConversationInterestWitness;
}): Promise<void> {
  try {
    const witness = input.witness ?? await readConversationInterestWitness(input.conversationId);
    if (!witness || witness.conversationId !== input.conversationId || !await witnessCurrent(witness)) return;
    const [conv, property] = await Promise.all([
      prisma.botConversation.findUnique({
        where: { id: input.conversationId },
        select: {
          id: true,
          channel: true,
          clientId: true,
          propertyChatAgentId: true,
          propertyChatAgent: { select: { fullName: true, isActive: true } },
          client: {
            select: {
              id: true,
              assignedAgentId: true,
              acceptedAt: true,
              assignReason: true,
              deletedAt: true,
              shortId: true,
            },
          },
        },
      }),
      liveProperty(input.propertyId),
    ]);
    if (!conv || conv.clientId !== witness.clientId || !property) return;
    const ownerId = propertyOwnerAgentId(property);
    if (!ownerId) return;
    const client = conv.client && !conv.client.deletedAt ? conv.client : null;
    if (client?.assignedAgentId === ownerId) return; // клиент уже у хозяина объекта
    if (!client?.assignedAgentId && conv.propertyChatAgentId === ownerId) return; // агент уже отвечает, новые сообщения уведомляются отдельно

    const owner = await prisma.agent.findUnique({ where: { id: ownerId }, select: { isActive: true, role: true } });
    const ownerActive = !!owner?.isActive;

    if (client?.assignedAgentId && ownerActive) {
      if (objectInterestPullsQueueLead() && owner?.role === "AGENT" && (await pullQueueLeadToOwner(client, ownerId, property, witness))) return;
      await noticeInterestInOtherAgentProperty({ clientId: client.id, propertyId: property.id, witness });
      return;
    }

    const recipients = ownerActive ? [ownerId] : await findAgentsWithPermission("clients.assign");
    if (recipients.length === 0) return;
    const tag = `interest-conv-${conv.id}-${property.id}`;
    if (inFlight.has(tag)) return;
    inFlight.add(tag);
    try {
      const recent = await prisma.notification.findFirst({
        where: { agentId: { in: recipients }, tag, createdAt: { gte: new Date(Date.now() - DEDUP_MS) } },
        select: { id: true },
      });
      if (recent) return;
      const where = channelLabel(conv.channel) || conv.channel;
      const state = client ? "клиент записан, но агента у него пока нет" : "заявка ещё не оформлена";
      const handledElsewhere = ownerActive && !!conv.propertyChatAgentId && conv.propertyChatAgentId !== ownerId;
      const handlerName = conv.propertyChatAgent?.fullName?.trim() || "другой агент";
      const payload = ownerActive
        ? {
            title: "👀 Интерес к вашему объекту",
            body: handledElsewhere
              ? `По вашему объекту №${property.shortId} пишут в ${where}. ${conv.propertyChatAgent?.isActive
                ? `Переписку уже ведёт ${handlerName} — согласуйте ответ с этим агентом.`
                : `Агент переписки ${handlerName} отключён — обратитесь к руководителю.`}`
              : `По вашему объекту №${property.shortId} пишут в ${where} (${state}). Переписка — в «Чатах».`,
          }
        : {
            title: "⚠️ По объекту пишут, а хозяина нет",
            body: `По объекту №${property.shortId} пишут в ${where} (${state}), а агент объекта отключён — передайте объект и ответьте клиенту.`,
          };
      if (!await ownerNoticeCurrent(property.id, ownerId, ownerActive, witness)) return;
      // No network under native/Inquiry locks. A provider request after this
      // point-in-time check is not atomically revocable (P12 remains separate).
      await sendPushToAgents(recipients, {
        ...payload,
        url: handledElsewhere ? `/properties/${property.shortId}` : `/messages?open=${conv.id}`,
        tag,
      });
      if (client) {
        await prisma.$transaction(async tx => {
          if (witness.clientId !== client.id) return;
          const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Client" WHERE "id"=${client.id} AND "deletedAt" IS NULL FOR UPDATE`;
          if (locked.length !== 1) return;
          if (!await lockConversationInterestWitness(tx, witness)) return;
          await logTimeline({
            clientId: client.id,
            actor: { kind: "client", source: ANON_SOURCE, subjectAgentId: ownerActive ? ownerId : undefined },
            type: "SYSTEM",
            propertyId: property.id,
            notes: ownerActive
              ? `Клиент пишет по объекту №${property.shortId} — агенту объекта отправлено уведомление.`
              : `Клиент пишет по объекту №${property.shortId}, агент объекта отключён — руководителю отправлено уведомление.`,
            tx,
          });
        });
      }
    } finally {
      // Строку ленты push.ts пишет фоном (void) — держим отметку ещё несколько
      // секунд, пока она не ляжет, иначе второе узнавание в той же пачке её не увидит.
      setTimeout(() => inFlight.delete(tag), 10_000).unref?.();
    }
  } catch (err) {
    void logSystemError("api", `Уведомление хозяину объекта о переписке не отправлено: ${describeError(err)}`, {
      dedupKey: "property-interest-conversation",
    });
  }
}

/**
 * Вариант (а) P0-7 — только при включённом флаге. Переезжает лишь непринятый лид,
 * выданный очередью: принятого клиента, названного клиентом сотрудника и лид по
 * другому объекту автоматика не трогает. Закон проверяет сам changeClientAgent
 * (canAutoTransfer); гонку с «Принять» держит условие на снимок в guardWhere.
 */
async function pullQueueLeadToOwner(
  client: { id: string; assignedAgentId: string | null; acceptedAt: Date | null; assignReason: string | null; shortId: number | null },
  ownerId: string,
  property: { id: string; shortId: number },
  witness: ConversationInterestWitness
): Promise<boolean> {
  if (client.acceptedAt || (client.assignReason && client.assignReason !== "queue")) return false;
  const now = new Date();
  const reason = `Клиент из очереди пишет по объекту №${property.shortId} — лид передан хозяину объекта до принятия`;
  const committed = await prisma.$transaction(async tx => {
    if (witness.clientId !== client.id) return null;
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Client" WHERE "id"=${client.id} AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length !== 1) return null;
    if (!await lockConversationInterestWitness(tx, witness)) return null;
    const currentClient = await tx.client.findUnique({ where: { id: client.id },
      select: { assignedAgentId: true, acceptedAt: true, assignReason: true, deletedAt: true, lastAgentId: true } });
    if (!currentClient || currentClient.deletedAt || currentClient.acceptedAt !== null ||
      currentClient.assignedAgentId !== client.assignedAgentId || currentClient.assignReason !== client.assignReason) return null;
    const live = await liveProperty(property.id, tx);
    if (!live || propertyOwnerAgentId(live) !== ownerId) return null;
    const owner = await tx.agent.findUnique({ where: { id: ownerId }, select: { isActive: true, role: true } });
    if (!owner?.isActive || owner.role !== "AGENT") return null;
    const changed = await changeClientAgent({
      clientId: client.id,
      toAgentId: ownerId,
      reason,
      actorId: null,
      source: "objectInterest.pull",
      interactionAgentId: ownerId,
      guardWhere: { assignedAgentId: client.assignedAgentId, acceptedAt: null, assignReason: client.assignReason },
      tx,
      // Exception: this scoped transaction must commit BEFORE the existing
      // autopilot/satellite work; the same work is dispatched below, not omitted.
      skipSatellites: true,
      data: {
        assignedAt: now,
        assignReason: "own_property_explicit",
        matchedPropertyId: property.id,
        ownPropertyLead: true,
      },
    });
    if (!changed.ok) return null;
    const freshWitness = await readConversationInterestWitness(witness.conversationId, tx);
    if (!freshWitness || freshWitness.clientId !== client.id || freshWitness.endpointScopeId !== witness.endpointScopeId) throw new Error("Interest transfer lost its native relation");
    return { witness: freshWitness, lastAgentId: currentClient.lastAgentId };
  });
  if (!committed) return false;
  try {
    runClientAutopilotInBackground(client.id, "agent_changed");
    await closeOwnershipSatellites({ clientId: client.id, clientShortId: client.shortId, fromAgentId: client.assignedAgentId,
      toAgentId: ownerId, reason: `[objectInterest.pull] ${reason}`, queueReturnFromAgentId: client.assignedAgentId ? null : committed.lastAgentId });
  } catch (error) {
    void logSystemError("api", `Лид по объекту передан, но последующие обновления не завершены: ${describeError(error)}`, { dedupKey: "property-interest-pull-satellites" });
  }
  if (!await ownerNoticeCurrent(property.id, ownerId, true, committed.witness)) return true; // local transfer succeeded; do not undo/replay it for a notification race
  sendLeadPush(ownerId, client.id, {
    title: "🔔 Новый лид по вашему объекту",
    body: `Клиент пишет по объекту №${property.shortId}, примите заявку`,
    url: `/clients/${client.shortId}`,
    tag: `lead-${client.id}`,
  }).catch((err) => console.error("[push] лид по объекту передан хозяину:", err));
  return true;
}
