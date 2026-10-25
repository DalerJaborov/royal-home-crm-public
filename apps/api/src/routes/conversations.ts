import fs from "node:fs/promises";
import { assignmentWriteDenied } from "../lib/assignmentCompletion.js";
import { shieldPauseFor } from "../lib/outboundShield.js";
import { loadCustomerTransportForConversation } from "../lib/customerConversationScope.js";
import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { z } from "zod";
import {
  conversationQuerySchema,
  botPauseSchema,
  replyFeedbackSchema,
  conversationClientLinkSchema,
  maskPhonesForReader,
  clientDisplayName,
  type ConversationMessage,
  type ClientKind,
  type ClientSource,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { agentSender, deliverToConversation, deliverVoiceToConversation, deliverMediaToConversation } from "../lib/conversationDelivery.js";
import { presentMessages, presentSender } from "../lib/messageAttachments.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "../lib/clientPhone.js";
import { chatScopeAgentId, conversationBelongsTo } from "../lib/chatScope.js";
import { ownBotConversationSql, ownBotConversationMineSql, ownBotConversationWhere } from "../lib/ownBotConversationScope.js";
import { contactProfileView } from "../lib/contactProfileView.js";
import { withHiddenConversationOrigin } from "../lib/clientOrigin.js";
import { listAccounts } from "../messengers/accounts.js";
import { voiceMessageUpload, mediaMessageUpload } from "../upload.js";
import { publishConversationUpdated } from "../lib/livePublish.js";
import { anyParams } from "../lib/routeParams.js";
import { logAudit } from "../lib/audit.js";
import { TG_PREFIX } from "../lib/conversationId.js";
import { applyReplyFeedback, ReplyFeedbackError } from "../lib/replyFeedback.js";
import { ConversationClientLinkError, linkConversationClient } from "../lib/conversationClientLink.js";

/**
 * Инбокс «Сообщения»: все диалоги мессенджер-бота (Instagram/Facebook/WhatsApp и любые
 * каналы Meta — BotConversation) плюс диалоги Telegram-бота (TelegramConversation)
 * в одном окне. Оператор может ответить клиенту прямо из CRM — ответ уходит через API
 * соответствующего транспорта (Meta или Telegram Bot API), бот при этом автоматически
 * ставится на паузу (иначе клиент получал бы два ответа: от человека и от ИИ). Видно
 * только руководству (админ/менеджер/директор) — рядовые агенты переписку бота не видят
 * вообще, только принятого клиента после приёма заявки.
 */
export const conversationsRouter = Router();
/**
 * ДВА ПРАВА НА ОДИН РАЗДЕЛ (владелец 07.09.2026: «чаты у агентов не работают,
 * почини везде»).
 *
 * `messages.view` — руководство, видит переписки всего агентства.
 * `messages.viewOwn` — агент, видит ТОЛЬКО клиентов, закреплённых за ним. Сужение
 * делает сервер (ownAgentId ниже), а не интерфейс: право, которое соблюдает только
 * фронтенд, не право, а надпись.
 */
conversationsRouter.use(requireAuth, (req, res, next) => {
  if (can(req, "messages.view") || can(req, "messages.viewOwn")) return next();
  return res.status(403).json({ error: "Недостаточно прав" });
});

/**
 * Один заслон на ВСЕ маршруты с `:id` — и чтение, и ответ, и пауза бота. Отдельная
 * проверка в каждом обработчике однажды забылась бы ровно в одном, и через него
 * читалась бы вся переписка агентства.
 *
 * 404, а не 403: чужой диалог для агента не «запрещён», его для него не существует —
 * иначе по коду ответа можно перебрать, какие диалоги вообще есть.
 */
conversationsRouter.use("/:id", async (req, res, next) => {
  const agentId = chatScopeAgentId(req);
  // `/groups/:groupId` has its own linked-client/direct-source ownership checks
  // below. The generic `/:id` middleware also matches its `groups` prefix.
  if (req.params.id === "groups") return next();
  if (agentId && !(await conversationBelongsTo(req.params.id, agentId))) {
    return res.status(404).json({ error: "Диалог не найден" });
  }
  // Reading old correspondence remains allowed; completed work cannot send new
  // replies, pause the bot, or change conversation links through the inbox.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const id = req.params.id;
    const conversation = id.startsWith(TG_PREFIX)
      ? await prisma.telegramConversation.findUnique({ where: { id: id.slice(TG_PREFIX.length) }, select: { client: { select: { assignmentCompletedAt: true } } } })
      : await prisma.botConversation.findUnique({ where: { id }, select: { client: { select: { assignmentCompletedAt: true } } } });
    const denied = conversation?.client && assignmentWriteDenied(conversation.client, req.agent?.role);
    if (denied) return res.status(403).json({ error: denied });
  }
  return next();
});

// Форма реплики переписки описана один раз в @royal-home/shared.
type StoredMessage = ConversationMessage;

/** Размер страницы инбокса — как у списка клиентов (Clients.tsx), для единообразия UI. */
const PAGE_SIZE = 20;
/** Потолок legacy single-source inbox. Grouped inbox pages/counts in SQL without this cap. */
const MAX_MERGE_CANDIDATES = 20_000;

/** Telegram-диалоги живут в отдельной таблице (TelegramConversation) — в едином
 *  инбоксе их id получают префикс, по нему роуты понимают, куда ходить. */
/** Префикс идентификатора диалога Telegram в инбоксе: у BotConversation и
 *  TelegramConversation свои таблицы и свои uuid, а инбокс показывает их одним
 *  списком. Экспортируется, потому что ссылку «открыть переписку» строит не
 *  только этот роут (см. routes/vacancies.ts): правило склейки должно жить в
 *  одном месте, иначе ссылка из другого раздела молча ведёт в пустоту. */
export { TG_PREFIX };

const TELEGRAM_CHANNEL = "TELEGRAM";

/**
 * Строка СПИСКА инбокса. Здесь намеренно нет тела переписки: списку нужны только
 * последняя реплика и длина, а колонка messages в живых диалогах весит килобайты.
 * Раньше список поднимал её целиком из обеих таблиц — на 60 диалогах по 300 реплик
 * это 3,5 МБ и 99 мс на каждый опрос вместо 31 КБ и 21 мс (замер перед правкой).
 */
interface ListRow {
  id: string;
  channel: string;
  name: string | null;
  subscriberId: string;
  lastMessageAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  pausedUntil: Date | null;
  /** С какого момента началась ТЕКУЩАЯ пауза (шаг 5 переноса, 10.09.2026) — null,
   *  если пауза не стоит или диалог никогда не ставили на паузу этим кодом. */
  botPausedAt: Date | null;
  messagesCount: number;
  /** messages -> -1: последний элемент массива, NULL если реплик нет. */
  lastMessage: StoredMessage | null;
  clientId: string | null;
  clientAssignedAgentId?: string | null;
  clientShortId: number | null;
  clientFullName: string | null;
  clientPhone: string | null;
  /** Только для отображаемого имени (clientDisplayName) — заменить заглушку вида
   *  «Продавец ПР-000388» на «Продавец из WhatsApp» в списке диалогов. Якорь
   *  (район/бюджет/адрес объекта) здесь не считается — список набирается сырым
   *  UNION по двум таблицам без остальных полей карточки, тянуть их всех сюда
   *  того не стоит; полный якорь агент видит на самой карточке клиента. */
  clientKind: ClientKind | null;
  clientSource: ClientSource | null;
  /** В какой НАШ аккаунт написал человек (null — диалог из времён одного аккаунта). */
  accountId?: string | null;
  accountTitle?: string | null;
  /** Клиент попросил живого агента, а тот ещё не ответил и не дозвонился —
   *  см. Client.agentAttentionRequestedAt (владелец 18.09.2026). Список
   *  ставит такой диалог первым и красным, пока это не null. */
  agentAttentionRequestedAt: Date | null;
}

/** Единая форма диалога для инбокса — независимо от таблицы-источника. */
interface UnifiedConversation {
  id: string;
  channel: string;
  name: string | null;
  subscriberId: string;
  messages: unknown;
  lastMessageAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  pausedUntil: Date | null;
  /** Досье собеседника — то, что бот читает перед ответом (lib/contactProfiles.ts).
   *  null у диалогов, начатых до появления досье: их ещё не разобрал бэкофилл. */
  contactProfileId: string | null;
  client: { id: string; shortId: number; fullName: string; phone: string | null } | null;
}

type GroupMessage = StoredMessage & { sourceConversationId: string; sourceChannel: string | null };

/** Read one exact linked client's histories for the grouped inbox. The client
 * relation is the only grouping key; every source is independently constrained
 * to the viewer's existing chat scope before its messages enter the timeline. */
conversationsRouter.get("/groups/:groupId", requireAuth, async (req, res) => {
  const key = req.params.groupId;
  const ownAgentId = chatScopeAgentId(req);
  const canSeeOrigin = can(req, "clients.viewOrigin");
  const canSeePhone = can(req, "clients.viewPhone");
  const attachmentsAllowed = can(req, "messages.viewAttachments");
  let clientId: string | null = null;
  let clientDetails: { id: string; shortId: number; fullName: string; phone: string | null } | null = null;
  let sources: Array<{ id: string; kind: "bot" | "telegram" | "telegram-direct"; channel: string; name: string | null; messages: unknown; pausedUntil: Date | null; readAt: Date | null; createdAt: Date; lastMessageAt: Date | null }> = [];

  if (key.startsWith("client:")) {
    clientId = key.slice("client:".length);
    if (!z.string().uuid().safeParse(clientId).success) return res.status(404).json({ error: "Диалог не найден" });
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, shortId: true, fullName: true, phone: true, assignedAgentId: true, acceptedAt: true, deletedAt: true } });
    if (!client || client.deletedAt) {
      return res.status(404).json({ error: "Диалог не найден" });
    }
    clientDetails = client;
    const canReadAcceptedSources = !ownAgentId || (client.assignedAgentId === ownAgentId && !!client.acceptedAt);
    const [bots, telegrams, direct] = await Promise.all([
      prisma.botConversation.findMany({ where: { clientId, ...(ownAgentId ? ownBotConversationWhere(ownAgentId) : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, channel: true, name: true, messages: true, pausedUntil: true, readAt: true, createdAt: true, lastMessageAt: true } }),
      canReadAcceptedSources ? prisma.telegramConversation.findMany({ where: { clientId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, username: true, messages: true, pausedUntil: true, readAt: true, createdAt: true, lastMessageAt: true } }) : Promise.resolve([]),
      canReadAcceptedSources ? prisma.telegramDirectConversation.findMany({ where: { clientId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, username: true, messages: true, pausedUntil: true, readAt: true, createdAt: true, lastMessageAt: true } }) : Promise.resolve([]),
    ]);
    sources = [
      ...bots.map((c) => ({ ...c, kind: "bot" as const })),
      ...telegrams.map((c) => ({ ...c, kind: "telegram" as const, channel: "TELEGRAM", name: c.username ? `@${c.username}` : null })),
      ...direct.map((c) => ({ ...c, kind: "telegram-direct" as const, channel: "TELEGRAM_DIRECT", name: c.username ? `@${c.username}` : null })),
    ];
  } else if (key.startsWith("td_")) {
    const direct = await prisma.telegramDirectConversation.findUnique({
      where: { id: key.slice(3) },
      select: {
        id: true, chatId: true, topicId: true, username: true, messages: true, pausedUntil: true,
        readAt: true, createdAt: true, lastMessageAt: true, clientId: true,
        client: { select: { id: true, shortId: true, fullName: true, phone: true, assignedAgentId: true, acceptedAt: true, deletedAt: true } },
      },
    });
    if (!direct || (ownAgentId && (!direct.client || direct.client.deletedAt || direct.client.assignedAgentId !== ownAgentId || !direct.client.acceptedAt))) {
      return res.status(404).json({ error: "Диалог не найден" });
    }
    clientId = direct.clientId;
    if (direct.client) clientDetails = direct.client;
    sources = [{
      id: direct.id, kind: "telegram-direct", channel: "TELEGRAM_DIRECT",
      name: direct.username ? `@${direct.username}` : null, messages: direct.messages,
      pausedUntil: direct.pausedUntil, readAt: direct.readAt, createdAt: direct.createdAt,
      lastMessageAt: direct.lastMessageAt,
    }];
  } else {
    return res.status(404).json({ error: "Диалог не найден" });
  }

  if (sources.length === 0) return res.status(404).json({ error: "Диалог не найден" });
  if (clientId && !clientDetails) {
    clientDetails = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, shortId: true, fullName: true, phone: true } });
  }

  const now = new Date();
  await Promise.all(sources.map(async (source) => {
    if (!needsReadReceipt(source)) return;
    if (source.kind === "bot") await prisma.botConversation.update({ where: { id: source.id }, data: { readAt: now } });
    else if (source.kind === "telegram") await prisma.telegramConversation.update({ where: { id: source.id }, data: { readAt: now } });
    else await prisma.telegramDirectConversation.update({ where: { id: source.id }, data: { readAt: now } });
    void publishConversationUpdated(source.kind, source.id);
  }));

  const sourceList = sources.map((source) => {
    const id = source.kind === "telegram" ? `${TG_PREFIX}${source.id}` : source.kind === "telegram-direct" ? `td_${source.id}` : source.id;
    return { id, channel: canSeeOrigin ? source.channel : null, canReply: source.kind !== "telegram-direct", pausedUntil: source.pausedUntil?.toISOString() ?? null };
  });
  const messages: Array<GroupMessage & { sourceOrder: number }> = [];
  for (const [sourceOrder, source] of sources.entries()) {
    const id = source.kind === "telegram" ? `${TG_PREFIX}${source.id}` : source.kind === "telegram-direct" ? `td_${source.id}` : source.id;
    if (!Array.isArray(source.messages)) continue;
    for (const [sourceMessageIndex, rawMessage] of source.messages.entries()) {
      const [message] = presentMessages([rawMessage], attachmentsAllowed, canSeePhone);
      if (!message) continue;
      messages.push({
        ...message,
        sourceConversationId: id,
        sourceMessageIndex,
        sourceChannel: canSeeOrigin ? source.channel : null,
        sourceOrder,
      });
    }
  }
  messages.sort((a, b) => {
    const at = a.at ? Date.parse(a.at) : Number.NEGATIVE_INFINITY;
    const bt = b.at ? Date.parse(b.at) : Number.NEGATIVE_INFINITY;
    return at - bt || a.sourceOrder - b.sourceOrder;
  });
  const channelNames = [...new Set(sources.map((source) => source.channel))];
  res.json({
    id: key,
    channel: canSeeOrigin ? (channelNames.length === 1 ? channelNames[0] : "MULTI") : null,
    name: clientDetails
      ? (canSeeOrigin ? clientNamePhoneSafe(clientDetails.fullName, canSeePhone) : "Клиент")
      : (canSeeOrigin ? sources[0]?.name ?? "Без имени" : "Клиент"),
    profileName: null,
    subscriberId: null,
    clientId: clientDetails?.id ?? null,
    clientShortId: clientDetails ? String(clientDetails.shortId) : null,
    clientPhone: clientDetails?.phone ? clientPhoneFor(clientDetails.phone, canSeePhone) : null,
    firstContactAt: sources.reduce((first, source) => source.createdAt < first ? source.createdAt : first, sources[0]!.createdAt).toISOString(),
    pausedUntil: null,
    shieldPause: null,
    messages: messages.map(({ sourceOrder: _sourceOrder, ...message }) => message),
    contact: null,
    grouped: true,
    sources: sourceList,
  });
});

const clientSelect = { select: { id: true, shortId: true, fullName: true, phone: true } } as const;

function fromTelegram(c: {
  id: string;
  chatId: string;
  username: string | null;
  messages: unknown;
  lastMessageAt: Date | null;
  readAt: Date | null;
  pausedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contactProfileId: string | null;
  client: UnifiedConversation["client"];
}): UnifiedConversation {
  return {
    id: TG_PREFIX + c.id,
    channel: TELEGRAM_CHANNEL,
    name: c.username ? `@${c.username}` : null,
    subscriberId: c.chatId,
    contactProfileId: c.contactProfileId,
    messages: c.messages,
    lastMessageAt: c.lastMessageAt,
    readAt: c.readAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    pausedUntil: c.pausedUntil,
    client: c.client,
  };
}

/**
 * Шаблон для ILIKE. % и _ в запросе человека — обычные символы, а не джокеры:
 * без экранирования поиск по «100%» находил бы вообще всё.
 */
function toLikePattern(q?: string): string | null {
  if (!q) return null;
  return `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
}

/**
 * Кандидаты для страницы списка из обеих таблиц.
 *
 * Тело переписки не поднимаем: последнюю реплику и длину массива считает сама
 * база (messages -> -1 и jsonb_array_length). Поиск по тексту тоже ушёл в SQL —
 * ILIKE по messages::text: раньше для этого вся переписка тянулась в приложение.
 *
 * jsonb_typeof-обёртка нужна на случай повреждённого значения: на не-массиве
 * jsonb_array_length падает с ошибкой и роняла бы весь инбокс из-за одной строки.
 *
 * Берём по page * PAGE_SIZE строк из каждой таблицы: чтобы собрать N-ю страницу
 * объединённого списка, больше из одного источника и не понадобится.
 */
/** Три среза списка (эталон messages.html, `.seg`) — параметры одни на выборку
 *  страницы, подсчёт совпадений и подсчёт сегментов (сводка ниже), чтобы число
 *  на кнопке и фактический список за ней никогда не расходились. */
interface SegmentFilters {
  /** Срез «Ждут человека»: последняя реплика — от клиента, ответа ещё нет. */
  needsHuman?: boolean;
  /** Срез «Бот на паузе»: pausedUntil ещё не истёк. */
  paused?: boolean;
  /** Срез «Мои»: клиент диалога закреплён за viewerAgentId. */
  mine?: boolean;
  /** Кто смотрит — нужен только срезу «Мои». */
  viewerAgentId?: string;
}

async function loadPageCandidates(
  page: number,
  channel?: string,
  q?: string,
  accountId?: string,
  /** Агент видит только своих принятых клиентов; null — руководство, видит всё. */
  ownAgentId?: string | null,
  segments: SegmentFilters = {}
): Promise<ListRow[]> {
  // Фильтр по нашему аккаунту (Royal Home / Royal Home Info) есть только у
  // мессенджеров Meta: у Telegram аккаунт один, и при выбранном аккаунте его
  // диалоги в список не попадают вовсе — иначе переключатель врал бы.
  const wantBot = !channel || channel !== TELEGRAM_CHANNEL;
  const wantTelegram = (!channel || channel === TELEGRAM_CHANNEL) && !accountId;
  // Второй предохранитель к потолку страницы в схеме: здесь читаются JSON-колонки
  // переписки, и цена ошибки выше, чем у обычного списка. Глубже этого места
  // объединённый список всё равно не собрать осмысленно — дальше ищут поиском.
  const take = Math.min(page * PAGE_SIZE, MAX_MERGE_CANDIDATES);
  const like = toLikePattern(q);
  // ${flag}::boolean IS NULL OR (условие) — тот же приём, что у channel/accountId
  // выше: срез выключен (флаг NULL) — фильтр пропускает всех, включён (TRUE) —
  // отсеивает по условию.
  const needsHumanFlag = segments.needsHuman ? true : null;
  const pausedFlag = segments.paused ? true : null;
  const mineAgentId = segments.mine ? (segments.viewerAgentId ?? null) : null;

  /**
   * СОРТИРОВКА ПО КОЛОНКЕ ИЗ ПРИСОЕДИНЁННОЙ ТАБЛИЦЫ УБИВАЛА `LIMIT` (19.09.2026).
   *
   * 18.09 сюда добавили просьбу живого агента первым ключом сортировки:
   * `ORDER BY cl."agentAttentionRequestedAt" IS NOT NULL DESC, ...`. Колонка
   * лежит в `Client`, до которого идёт LEFT JOIN, поэтому база больше не могла
   * взять нужные строки по индексу на самой переписке и остановиться на
   * `LIMIT` — ей приходилось отсортировать ВЕСЬ join целиком, с разворотом
   * jsonb у каждой строки. Это самый открытый экран в CRM, и стоило это
   * ровно тем, из-за чего разбор и начался: «то дашборд не грузится, то чаты».
   *
   * Теперь основной проход снова сортируется только по свежести сообщения, то
   * есть по индексу. Помеченные диалоги добираются ОТДЕЛЬНЫМ маленьким
   * проходом (`attentionOnly`) — их единицы, и предварительная проверка ниже
   * вообще пропускает этот проход, когда таких клиентов нет, а это обычный
   * случай. Порядок «просьба живого агента впереди всего» держит сортировка в
   * памяти ниже — она и раньше была здесь единственным местом, где итоговый
   * объединённый список упорядочивается.
   */
  const queryBot = (attentionOnly: boolean | null) =>
    prisma.$queryRaw<ListRow[]>`
          SELECT c.id, c.channel, c.name, c."subscriberId", c."accountId", acc.title AS "accountTitle",
                 c."lastMessageAt", c."readAt", c."createdAt", c."updatedAt", c."pausedUntil", c."botPausedAt",
                 CASE WHEN jsonb_typeof(c.messages) = 'array' THEN jsonb_array_length(c.messages) ELSE 0 END AS "messagesCount",
                 CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
                 cl.id AS "clientId", cl."assignedAgentId" AS "clientAssignedAgentId", cl."shortId" AS "clientShortId",
                 cl."fullName" AS "clientFullName", cl.phone AS "clientPhone",
                 cl.kind AS "clientKind", cl.source AS "clientSource",
                 cl."agentAttentionRequestedAt" AS "agentAttentionRequestedAt"
          FROM "BotConversation" c
          LEFT JOIN "Client" cl ON cl.id = c."clientId"
          LEFT JOIN "MessengerAccount" acc ON acc.id = c."accountId"
          WHERE (${channel ?? null}::text IS NULL OR c.channel = ${channel ?? null})
            AND (${accountId ?? null}::text IS NULL OR c."accountId" = ${accountId ?? null})
            AND (
              ${like}::text IS NULL
              OR cl."fullName" ILIKE ${like}
              OR c.name ILIKE ${like}
              OR c.messages::text ILIKE ${like}
            )
            AND (${ownBotConversationSql(ownAgentId)})
            AND (
              ${needsHumanFlag}::boolean IS NULL
              OR (jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user')
            )
            AND (
              ${pausedFlag}::boolean IS NULL
              OR (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now())
            )
            AND (
              ${ownBotConversationMineSql(mineAgentId)}
            )
            AND (
              ${attentionOnly}::boolean IS NULL
              OR cl."agentAttentionRequestedAt" IS NOT NULL
            )
          ORDER BY COALESCE(c."lastMessageAt", c."updatedAt") DESC, c.id DESC
          LIMIT ${take}
        `
  const queryTelegram = (attentionOnly: boolean | null) =>
    prisma.$queryRaw<ListRow[]>`
          SELECT ${TG_PREFIX} || c.id AS id,
                 ${TELEGRAM_CHANNEL}::text AS channel,
                 CASE WHEN c.username IS NULL THEN NULL ELSE '@' || c.username END AS name,
                 c."chatId" AS "subscriberId",
                 c."lastMessageAt", c."readAt", c."createdAt", c."updatedAt", c."pausedUntil", c."botPausedAt",
                 CASE WHEN jsonb_typeof(c.messages) = 'array' THEN jsonb_array_length(c.messages) ELSE 0 END AS "messagesCount",
                 CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
                 cl.id AS "clientId", cl."assignedAgentId" AS "clientAssignedAgentId", cl."shortId" AS "clientShortId",
                 cl."fullName" AS "clientFullName", cl.phone AS "clientPhone",
                 cl.kind AS "clientKind", cl.source AS "clientSource",
                 cl."agentAttentionRequestedAt" AS "agentAttentionRequestedAt"
          FROM "TelegramConversation" c
          LEFT JOIN "Client" cl ON cl.id = c."clientId"
          WHERE (
              ${like}::text IS NULL
              OR cl."fullName" ILIKE ${like}
              OR c.username ILIKE ${like}
              OR c.messages::text ILIKE ${like}
            )
            AND (
              ${ownAgentId ?? null}::text IS NULL
              OR (cl.id IS NOT NULL AND cl."assignedAgentId" = ${ownAgentId ?? null}
                  AND cl."deletedAt" IS NULL AND cl."acceptedAt" IS NOT NULL)
            )
            AND (
              ${needsHumanFlag}::boolean IS NULL
              OR (jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user')
            )
            AND (
              ${pausedFlag}::boolean IS NULL
              OR (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now())
            )
            AND (
              ${mineAgentId}::text IS NULL
              OR (cl.id IS NOT NULL AND cl."assignedAgentId" = ${mineAgentId})
            )
            AND (
              ${attentionOnly}::boolean IS NULL
              OR cl."agentAttentionRequestedAt" IS NOT NULL
            )
          ORDER BY COALESCE(c."lastMessageAt", c."updatedAt") DESC, c.id DESC
          LIMIT ${take}
        `
  // Есть ли вообще кому просить живого агента в этой области видимости.
  // Запрос дешёвый и идёт по индексу [assignedAgentId, agentAttentionRequestedAt]
  // (миграция 20260918113344), а платим мы им за то, что второго прохода в
  // обычный день не будет вовсе.
  const attentionScope = ownAgentId ?? mineAgentId;
  const hasAttention =
    (await prisma.client.findFirst({
      where: {
        agentAttentionRequestedAt: { not: null },
        ...(attentionScope ? { assignedAgentId: attentionScope } : {}),
      },
      select: { id: true },
    })) !== null;

  const [botRows, tgRows, botAttention, tgAttention] = await Promise.all([
    wantBot ? queryBot(null) : Promise.resolve([] as ListRow[]),
    wantTelegram ? queryTelegram(null) : Promise.resolve([] as ListRow[]),
    hasAttention && wantBot ? queryBot(true) : Promise.resolve([] as ListRow[]),
    hasAttention && wantTelegram ? queryTelegram(true) : Promise.resolve([] as ListRow[]),
  ]);

  // Два прохода могут поднять одну и ту же строку — склеиваем по id, иначе
  // помеченный диалог задвоился бы в списке.
  const unique = new Map<string, ListRow>();
  for (const row of [...botAttention, ...tgAttention, ...botRows, ...tgRows]) unique.set(row.id, row);

  // Просьба живого агента — впереди всего остального (владелец 18.09.2026),
  // а внутри каждой из двух групп — как раньше, по свежести сообщения.
  return [...unique.values()].sort((a, b) => {
    const attentionDiff = Number(!!b.agentAttentionRequestedAt) - Number(!!a.agentAttentionRequestedAt);
    if (attentionDiff !== 0) return attentionDiff;
    const timeDiff = (b.lastMessageAt ?? b.updatedAt).getTime() - (a.lastMessageAt ?? a.updatedAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    // Равное время — по id, тот же порядок, что у ORDER BY выше: иначе два
    // диалога с одной секундой менялись местами между страницами, и строка
    // задваивалась на одной и пропадала с другой.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Сколько всего диалогов подходит под фильтр. Считается в базе, а не по длине
 * выборки: раньше total равнялся числу поднятых кандидатов и упирался в потолок,
 * из-за чего пагинация дальше него просто не листалась.
 */
async function countMatches(
  channel?: string,
  q?: string,
  accountId?: string,
  ownAgentId?: string | null,
  segments: SegmentFilters = {}
): Promise<number> {
  const wantBot = !channel || channel !== TELEGRAM_CHANNEL;
  const wantTelegram = (!channel || channel === TELEGRAM_CHANNEL) && !accountId;
  const like = toLikePattern(q);
  const needsHumanFlag = segments.needsHuman ? true : null;
  const pausedFlag = segments.paused ? true : null;
  const mineAgentId = segments.mine ? (segments.viewerAgentId ?? null) : null;

  const [bot, tg] = await Promise.all([
    wantBot
      ? prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count
          FROM "BotConversation" c
          LEFT JOIN "Client" cl ON cl.id = c."clientId"
          WHERE (${channel ?? null}::text IS NULL OR c.channel = ${channel ?? null})
            AND (${accountId ?? null}::text IS NULL OR c."accountId" = ${accountId ?? null})
            AND (
              ${like}::text IS NULL
              OR cl."fullName" ILIKE ${like}
              OR c.name ILIKE ${like}
              OR c.messages::text ILIKE ${like}
            )
            AND (${ownBotConversationSql(ownAgentId)})
            AND (
              ${needsHumanFlag}::boolean IS NULL
              OR (jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user')
            )
            AND (
              ${pausedFlag}::boolean IS NULL
              OR (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now())
            )
            AND (
              ${ownBotConversationMineSql(mineAgentId)}
            )
        `
      : Promise.resolve([{ count: 0n }]),
    wantTelegram
      ? prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count
          FROM "TelegramConversation" c
          LEFT JOIN "Client" cl ON cl.id = c."clientId"
          WHERE (
              ${like}::text IS NULL
              OR cl."fullName" ILIKE ${like}
              OR c.username ILIKE ${like}
              OR c.messages::text ILIKE ${like}
            )
            AND (
              ${ownAgentId ?? null}::text IS NULL
              OR (cl.id IS NOT NULL AND cl."assignedAgentId" = ${ownAgentId ?? null}
                  AND cl."deletedAt" IS NULL AND cl."acceptedAt" IS NOT NULL)
            )
            AND (
              ${needsHumanFlag}::boolean IS NULL
              OR (jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user')
            )
            AND (
              ${pausedFlag}::boolean IS NULL
              OR (c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now())
            )
            AND (
              ${mineAgentId}::text IS NULL
              OR (cl.id IS NOT NULL AND cl."assignedAgentId" = ${mineAgentId})
            )
        `
      : Promise.resolve([{ count: 0n }]),
  ]);

  return Number(bot[0]?.count ?? 0) + Number(tg[0]?.count ?? 0);
}

/**
 * Счётчики трёх срезов (`.seg .n` эталона) — ОДИН запрос с FILTER на таблицу,
 * а не по три отдельных COUNT: без этого страница списка делала бы семь
 * запросов вместо трёх (общий + needsHuman + paused + mine), а числа на
 * кнопках рисковали разойтись с фактическим списком за кнопкой при любой
 * будущей правке фильтра в одном месте и забытой в другом.
 *
 * Печатает те же базовые условия (канал/аккаунт/поиск/своя область), что и
 * список и countMatches — иначе плашка «Все 312» и список за ней разойдутся.
 */
async function loadSegmentCounts(
  channel: string | undefined,
  q: string | undefined,
  accountId: string | undefined,
  ownAgentId: string | null,
  viewerAgentId: string
): Promise<{ all: number; needsHuman: number; paused: number; mine: number }> {
  const wantBot = !channel || channel !== TELEGRAM_CHANNEL;
  const wantTelegram = (!channel || channel === TELEGRAM_CHANNEL) && !accountId;
  const like = toLikePattern(q);

  type Counts = { all: bigint; needsHuman: bigint; paused: bigint; mine: bigint };
  const zero: Counts = { all: 0n, needsHuman: 0n, paused: 0n, mine: 0n };

  const [bot, tg] = await Promise.all([
    wantBot
      ? prisma.$queryRaw<Counts[]>`
          SELECT
            COUNT(*) AS "all",
            COUNT(*) FILTER (
              WHERE jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user'
            ) AS "needsHuman",
            COUNT(*) FILTER (WHERE c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()) AS "paused",
            COUNT(*) FILTER (
              WHERE (${ownBotConversationMineSql(viewerAgentId)})
            ) AS "mine"
          FROM "BotConversation" c
          LEFT JOIN "Client" cl ON cl.id = c."clientId"
          WHERE (${channel ?? null}::text IS NULL OR c.channel = ${channel ?? null})
            AND (${accountId ?? null}::text IS NULL OR c."accountId" = ${accountId ?? null})
            AND (
              ${like}::text IS NULL
              OR cl."fullName" ILIKE ${like}
              OR c.name ILIKE ${like}
              OR c.messages::text ILIKE ${like}
            )
            AND (${ownBotConversationSql(ownAgentId)})
        `
      : Promise.resolve([zero]),
    wantTelegram
      ? prisma.$queryRaw<Counts[]>`
          SELECT
            COUNT(*) AS "all",
            COUNT(*) FILTER (
              WHERE jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user'
            ) AS "needsHuman",
            COUNT(*) FILTER (WHERE c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()) AS "paused",
            COUNT(*) FILTER (
              WHERE cl.id IS NOT NULL AND cl."assignedAgentId" = ${viewerAgentId}
            ) AS "mine"
          FROM "TelegramConversation" c
          LEFT JOIN "Client" cl ON cl.id = c."clientId"
          WHERE (
              ${like}::text IS NULL
              OR cl."fullName" ILIKE ${like}
              OR c.username ILIKE ${like}
              OR c.messages::text ILIKE ${like}
            )
            AND (
              ${ownAgentId ?? null}::text IS NULL
              OR (cl.id IS NOT NULL AND cl."assignedAgentId" = ${ownAgentId ?? null}
                  AND cl."deletedAt" IS NULL AND cl."acceptedAt" IS NOT NULL)
            )
        `
      : Promise.resolve([zero]),
  ]);

  const b = bot[0] ?? zero;
  const t = tg[0] ?? zero;
  return {
    all: Number(b.all) + Number(t.all),
    needsHuman: Number(b.needsHuman) + Number(t.needsHuman),
    paused: Number(b.paused) + Number(t.paused),
    mine: Number(b.mine) + Number(t.mine),
  };
}

const PAUSED_OVER_DAY_MS = 24 * 60 * 60 * 1000;
/** Сколько имён везём в тихую строку («У двоих...: Далер Саидов, Шахзод Рахимов») —
 *  само число берёт count, список имён только для текста, длиннее не нужно. */
const PAUSED_OVER_DAY_NAMES_LIMIT = 3;

interface InboxAlerts {
  /** Диалог, который дольше всех ждёт живого человека (последняя реплика — от
   *  клиента, ответа ещё нет). null — таких сейчас нет. */
  longestWaitingHuman: { id: string; name: string | null; waitingMinutes: number } | null;
  /** Сколько диалогов стоят на паузе дольше суток, и первые имена для строки. */
  pausedOverDay: { count: number; names: string[] };
}

/**
 * Две тихие строки сверху инбокса (эталон, `.quiet.crit` / `.quiet.warn`
 * `#tpl-messages`): «X ждёт человека N минут» и «У двоих бот на паузе больше
 * суток». Область та же, что у списка (`ownAgentId`) — агент не должен узнавать
 * из предупреждения имя клиента коллеги, которого сам не видит в списке.
 *
 * Не зависит от текущих channel/accountId/q: предупреждение о самом старом
 * ожидании — свойство ВСЕГО инбокса в области видимости, а не текущей вкладки
 * поиска, иначе строка исчезала бы, стоило выбрать канал, где именно этот
 * диалог не лежит.
 */
async function loadInboxAlerts(
  ownAgentId: string | null,
  canSeeOrigin: boolean,
  // Право на телефон (22.09.2026): тихие строки инбокса берут имя из cl."fullName"
  // сырым, а у карточек незнакомых звонивших номер лежит в имени.
  canSeePhone: boolean
): Promise<InboxAlerts> {
  const scope = ownAgentId
    ? Prisma.sql`cl.id IS NOT NULL AND cl."assignedAgentId" = ${ownAgentId} AND cl."deletedAt" IS NULL AND cl."acceptedAt" IS NOT NULL`
    : Prisma.sql`TRUE`;

  // «Ждёт человека» — красная строка, поэтому только настоящее ожидание: бот
  // стоит на паузе (человеку передали) и клиент писал за последние сутки.
  // Раньше брался ЛЮБОЙ диалог с клиентской репликой последней, и красным годами
  // висел мёртвый чат (66363 мин ≈ 46 суток), которого никто уже не ждёт. Старше
  // суток — это уже строка «бот на паузе больше суток» ниже.
  const dayAgoWaiting = new Date(Date.now() - PAUSED_OVER_DAY_MS);
  type WaitingRow = { id: string; clientFullName: string | null; name: string | null; lastMessageAt: Date };
  const [botWaiting, tgWaiting] = await Promise.all([
    prisma.$queryRaw<WaitingRow[]>`
      SELECT c.id, cl."fullName" AS "clientFullName", c.name, c."lastMessageAt"
      FROM "BotConversation" c
      LEFT JOIN "Client" cl ON cl.id = c."clientId"
      WHERE jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user'
        AND c."lastMessageAt" IS NOT NULL
        AND c."lastMessageAt" > ${dayAgoWaiting}
        AND c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()
        AND (${ownBotConversationSql(ownAgentId)})
      ORDER BY c."lastMessageAt" ASC
      LIMIT 1
    `,
    prisma.$queryRaw<WaitingRow[]>`
      SELECT ${TG_PREFIX} || c.id AS id, cl."fullName" AS "clientFullName",
             CASE WHEN c.username IS NULL THEN NULL ELSE '@' || c.username END AS name,
             c."lastMessageAt"
      FROM "TelegramConversation" c
      LEFT JOIN "Client" cl ON cl.id = c."clientId"
      WHERE jsonb_typeof(c.messages) = 'array' AND (c.messages -> -1 ->> 'role') = 'user'
        AND c."lastMessageAt" IS NOT NULL
        AND c."lastMessageAt" > ${dayAgoWaiting}
        AND c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()
        AND (${scope})
      ORDER BY c."lastMessageAt" ASC
      LIMIT 1
    `,
  ]);
  const oldest = [...botWaiting, ...tgWaiting].sort(
    (a, b) => a.lastMessageAt.getTime() - b.lastMessageAt.getTime()
  )[0];
  const longestWaitingHuman = oldest
    ? {
        id: oldest.id,
        name: oldest.clientFullName
          ? clientNamePhoneSafe(oldest.clientFullName, canSeePhone)
          : (canSeeOrigin && oldest.name ? clientNamePhoneSafe(oldest.name, canSeePhone) : null),
        waitingMinutes: Math.max(0, Math.round((Date.now() - oldest.lastMessageAt.getTime()) / 60_000)),
      }
    : null;

  const dayAgo = new Date(Date.now() - PAUSED_OVER_DAY_MS);
  const botScopeWhere: Prisma.BotConversationWhereInput = {
    pausedUntil: { gt: new Date() },
    botPausedAt: { lt: dayAgo },
    ...(ownAgentId ? ownBotConversationWhere(ownAgentId) : {}),
  };
  const tgScopeWhere: Prisma.TelegramConversationWhereInput = {
    pausedUntil: { gt: new Date() },
    botPausedAt: { lt: dayAgo },
    ...(ownAgentId ? { client: { is: { assignedAgentId: ownAgentId, deletedAt: null, acceptedAt: { not: null } } } } : {}),
  };

  const [botPausedCount, tgPausedCount, botPausedSample, tgPausedSample] = await Promise.all([
    prisma.botConversation.count({ where: botScopeWhere }),
    prisma.telegramConversation.count({ where: tgScopeWhere }),
    prisma.botConversation.findMany({
      where: botScopeWhere,
      select: { name: true, botPausedAt: true, client: { select: { fullName: true } } },
      orderBy: { botPausedAt: "asc" },
      take: PAUSED_OVER_DAY_NAMES_LIMIT,
    }),
    prisma.telegramConversation.findMany({
      where: tgScopeWhere,
      select: { username: true, botPausedAt: true, client: { select: { fullName: true } } },
      orderBy: { botPausedAt: "asc" },
      take: PAUSED_OVER_DAY_NAMES_LIMIT,
    }),
  ]);

  const names = [
    ...botPausedSample.map((r) => ({
      name: (r.client?.fullName ? clientNamePhoneSafe(r.client.fullName, canSeePhone) : (canSeeOrigin && r.name ? clientNamePhoneSafe(r.name, canSeePhone) : null)) ?? "Без имени",
      at: r.botPausedAt as Date,
    })),
    ...tgPausedSample.map((r) => ({
      name:
        (r.client?.fullName
          ? clientNamePhoneSafe(r.client.fullName, canSeePhone)
          : (canSeeOrigin && r.username ? clientNamePhoneSafe(`@${r.username}`, canSeePhone) : null)) ?? "Без имени",
      at: r.botPausedAt as Date,
    })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, PAUSED_OVER_DAY_NAMES_LIMIT)
    .map((r) => r.name);

  return {
    longestWaitingHuman,
    pausedOverDay: { count: botPausedCount + tgPausedCount, names },
  };
}

/** Строка списка → то, что видит фронт. Форма ответа не изменилась. */
/**
 * `canSeeOrigin` — право `clients.viewOrigin` (см. lib/clientOrigin.ts). Без него
 * агент не видит ни канал, ни ник: и значок мессенджера, и «@user123» отвечают на
 * вопрос «откуда пришёл клиент», по которому его находят в обход агентства
 * (решение владельца 17.08.2026). Переписка при этом открыта — скрывается
 * подсказка, а не содержание.
 *
 * `phonesAllowed` — право `clients.viewPhone`. Превью последней реплики шло сырым
 * (07.09.2026): текст брался прямо из jsonb мимо presentMessages, который маскирует
 * номера в САМОЙ переписке. Клиент диктует номер в чат постоянно, и такая реплика
 * почти всегда последняя — значит запрет обходился просто открытием списка диалогов,
 * даже не входя в переписку. Маскируем тем же maskPhones и тем же правом.
 */
/**
 * СКОЛЬКО НЕПРОЧИТАННЫХ РЕПЛИК В ДИАЛОГЕ (владелец 12.09.2026: «покажи числом,
 * а не точкой»).
 *
 * До этого дня признак был булев: `unread = последняя реплика от клиента и
 * диалог не открывали после неё`. Точка отвечала «что-то есть», но не «одно
 * сообщение или пятнадцать», а разница между ними — это разница между «отвечу
 * после обеда» и «бросай всё».
 *
 * ЧТО СЧИТАЕТСЯ. Хвост подряд идущих реплик клиента в конце переписки — то
 * есть сколько раз человек написал ПОСЛЕ последнего ответа бота или агента.
 * Не «сообщения новее readAt»: у реплик в jsonb поле `at` необязательно (у
 * старых диалогов его нет вовсе), и счёт по нему у половины базы дал бы ноль.
 * Хвост же есть всегда и совпадает с тем, что человек видит, открывая чат.
 *
 * ОДИН ЗАПРОС НА СТРАНИЦУ, А НЕ НА СТРОКУ. Считается ПОСЛЕ нарезки страницы, по
 * двадцати идентификаторам: кандидатов `loadPageCandidates` поднимает до
 * page × 20 из каждой таблицы (до 20 000), и разворачивать jsonb каждому из них
 * стоило бы дороже всего списка. Обе таблицы — одним UNION ALL.
 */
async function loadUnreadCounts(rows: ListRow[]): Promise<Map<string, number>> {
  const botIds = rows.filter((r) => !r.id.startsWith(TG_PREFIX)).map((r) => r.id);
  const tgIds = rows.filter((r) => r.id.startsWith(TG_PREFIX)).map((r) => r.id.slice(TG_PREFIX.length));
  const directIds = rows.filter((r) => r.id.startsWith("td_")).map((r) => r.id.slice(3));
  const realBotIds = botIds.filter((id) => !id.startsWith("td_"));
  if (realBotIds.length === 0 && tgIds.length === 0 && directIds.length === 0) return new Map();

  // Хвост клиента: реплики с порядковым номером БОЛЬШЕ, чем у последней реплики
  // не-клиента. Нет ответов вовсе — граница 0, и считается вся переписка.
  const tailSql = (table: string) => Prisma.sql`
    SELECT c.id AS id, (
      SELECT COUNT(*)::int
        FROM jsonb_array_elements(c."messages") WITH ORDINALITY AS m(v, ord)
       WHERE (m.v ->> 'role') = 'user'
         AND m.ord > COALESCE((
           SELECT MAX(m2.ord)
             FROM jsonb_array_elements(c."messages") WITH ORDINALITY AS m2(v, ord)
            WHERE (m2.v ->> 'role') IS DISTINCT FROM 'user'
         ), 0)
    ) AS n
      FROM ${Prisma.raw(`"${table}"`)} c
     WHERE jsonb_typeof(c."messages") = 'array'`;

  const parts: Prisma.Sql[] = [];
  if (realBotIds.length > 0) parts.push(Prisma.sql`${tailSql("BotConversation")} AND c.id = ANY(${realBotIds}::text[])`);
  if (tgIds.length > 0) {
    parts.push(
      Prisma.sql`SELECT ${TG_PREFIX} || t.id AS id, t.n AS n FROM (${tailSql("TelegramConversation")} AND c.id = ANY(${tgIds}::text[])) t`
    );
  }
  if (directIds.length > 0) {
    parts.push(Prisma.sql`SELECT ${"td_"} || t.id AS id, t.n AS n FROM (${tailSql("TelegramDirectConversation")} AND c.id = ANY(${directIds}::text[])) t`);
  }

  const result = await prisma.$queryRaw<{ id: string; n: number }[]>(Prisma.join(parts, " UNION ALL "));
  return new Map(result.map((r) => [r.id, Number(r.n)]));
}

function presentListRow(c: ListRow, canSeeOrigin: boolean, phonesAllowed: boolean, unreadCounts: Map<string, number>) {
  const lastAt = c.lastMessageAt ?? c.updatedAt;
  const last = c.lastMessage && typeof c.lastMessage === "object" ? c.lastMessage : null;
  const unread = last?.role === "user" && (!c.readAt || lastAt.getTime() > c.readAt.getTime());
  // Заглушку («Продавец ПР-000388») в имени диалога подменяем на «Продавец из
  // WhatsApp» той же функцией, что и в списке клиентов (владелец 21.09.2026) —
  // только когда имя пришло от Client, а не от самого мессенджера (c.name).
  const displayName = c.clientFullName
    ? clientDisplayName({ fullName: c.clientFullName, kind: c.clientKind, source: c.clientSource })
    : null;
  // Имя диалога — по праву на телефон (22.09.2026): clientDisplayName подменяет
  // ТОЛЬКО каноническую заглушку («Продавец ПР-000388»), а «Входящий +992918…»
  // ей не является и проходит насквозь. Тот же обход, что везде — номер в имени.
  const safeName = displayName ? (phonesAllowed ? displayName : clientNamePhoneSafe(displayName, false)) : null;
  const shown = withHiddenConversationOrigin(
    { channel: c.channel, name: safeName ?? (c.name ? clientNamePhoneSafe(c.name, phonesAllowed) : null) },
    canSeeOrigin
  );
  return {
    id: c.id,
    channel: shown.channel,
    name: shown.name,
    clientShortId: c.clientShortId ?? null,
    // Маскируем ДО обрезки, а не после: обрезка на 160-м символе может разрубить
    // номер пополам, и половина цифр перестанет быть номером для maskPhones —
    // утекла бы ровно та часть, что попала в превью.
    //
    // `by` — не украшение: без него senderPrefix получал undefined и подписывал
    // «Бот:» КАЖДУЮ последнюю реплику, даже написанную живым агентом (07.09.2026).
    // Через presentSender(), а не сырым `last.by` — та же проверка формы, что и у
    // полной ленты (см. messageAttachments.ts): jsonb не заслуживает доверия и
    // здесь, чужеродное значение обязано превращаться в `undefined`, а не течь
    // на фронт как есть.
    lastMessage: last
      ? {
          role: last.role,
          content: (phonesAllowed ? String(last.content) : maskPhonesForReader(String(last.content)).text).slice(0, 160),
          by: presentSender(last.by),
        }
      : null,
    lastMessageAt: lastAt,
    paused: !!c.pausedUntil && c.pausedUntil.getTime() > Date.now(),
    // С какого момента диалог ЖДЁТ ЖИВОГО ЧЕЛОВЕКА (шаг 5 переноса, 10.09.2026,
    // предупреждения `.quiet` над списком) — последняя реплика в истории от
    // клиента, и ни бот, ни агент на неё ещё не ответили: тот же признак, что и
    // у `unread` ниже, момент — тот же lastMessageAt (он двигается только
    // входящими, см. schema.prisma у BotConversation.lastMessageAt).
    awaitingHumanSince: last?.role === "user" ? lastAt : null,
    // С какого момента стоит ТЕКУЩАЯ пауза — только пока она действует; истёкшая
    // или никогда не ставившаяся этим кодом дата в интерфейс не идёт (см.
    // botPausedAt в schema.prisma).
    pausedSince: c.pausedUntil && c.pausedUntil.getTime() > Date.now() ? c.botPausedAt ?? null : null,
    // «Непрочитано»: последняя реплика — от клиента, и диалог не открывали после неё.
    unread,
    /**
     * СКОЛЬКО ИМЕННО непрочитано (владелец 12.09.2026) — хвост подряд идущих
     * реплик клиента, см. loadUnreadCounts выше. Ноль, если диалог прочитан:
     * хвост в переписке остаётся и после открытия, «непрочитанность» задаёт
     * readAt, а не содержимое.
     *
     * Запасное значение 1 — не выдумка: сюда попадают только строки, у которых
     * unread уже true, то есть хотя бы одна непрочитанная реплика есть заведомо;
     * подсчёт мог не вернуть строку лишь если диалог удалили между двумя
     * запросами. Ноль в этом месте был бы враньём в другую сторону.
     */
    unreadCount: unread ? unreadCounts.get(c.id) ?? 1 : 0,
    messagesCount: Number(c.messagesCount ?? 0),
    // Клиент попросил живого агента, а тот ещё не ответил/не дозвонился —
    // список ставит такую карточку первой и красной (владелец 18.09.2026).
    agentAttentionRequestedAt: c.agentAttentionRequestedAt ?? null,
    accountId: c.accountId ?? null,
    // Название нашего аккаунта («Royal Home Info») тоже выдаёт платформу тому, кто
    // знает состав аккаунтов, — прячем вместе с каналом, иначе запрет обходится
    // догадкой. accountId оставляем: это внутренний ключ, платформы он не называет.
    accountTitle: canSeeOrigin ? c.accountTitle ?? null : null,
  };
}

interface GroupedInboxRow extends ListRow {
  groupId: string;
  sourceConversationIds: string[];
  channels: string[];
  unreadCount: number;
  unread: boolean;
  awaitingHumanSince: Date | null;
  messagesCount: number;
}

/**
 * The grouped inbox is an explicit, opt-in view. It first collects the readable
 * source conversations, then groups by the exact persisted Client.id; unlinked
 * conversations remain separate. Pagination is applied only after grouping.
 *
 * The source-filtered set is grouped and counted in SQL before page boundaries;
 * only page source summaries and unread tails are materialized.
 */
async function loadGroupedInboxRows(input: {
  channel?: string;
  q?: string;
  accountId?: string;
  ownAgentId: string | null;
  viewerAgentId: string;
  page: number;
  segments: SegmentFilters;
  canSeeOrigin: boolean;
  phonesAllowed: boolean;
}) {
  const { channel, q, accountId, ownAgentId, viewerAgentId, page, segments, canSeeOrigin, phonesAllowed } = input;
  const like = toLikePattern(q);
  const includeBot = !channel || (channel !== TELEGRAM_CHANNEL && channel !== "TELEGRAM_DIRECT");
  const includeTelegram = (!channel || channel === TELEGRAM_CHANNEL) && !accountId;
  // Telegram Direct is a read-only source: it has no safe CRM reply transport.
  const includeDirect = (!channel || channel === "TELEGRAM_DIRECT") && !accountId;
  const botScope = ownBotConversationSql(ownAgentId);
  const ownClientScope = ownAgentId
    ? Prisma.sql`cl.id IS NOT NULL AND cl."assignedAgentId" = ${ownAgentId} AND cl."deletedAt" IS NULL AND cl."acceptedAt" IS NOT NULL`
    : Prisma.sql`cl.id IS NULL OR cl."deletedAt" IS NULL`;
  const botRows = includeBot ? Prisma.sql`
    SELECT c.id, c.id AS "sourceId", 'bot'::text AS kind, c.channel,
      c.name, c."subscriberId", c."accountId", acc.title AS "accountTitle",
      c."lastMessageAt", c."readAt", c."createdAt", c."updatedAt", c."pausedUntil", c."botPausedAt",
      CASE WHEN jsonb_typeof(c.messages) = 'array' THEN jsonb_array_length(c.messages) ELSE 0 END AS "messagesCount",
      CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
      cl.id AS "clientId", cl."assignedAgentId" AS "clientAssignedAgentId", cl."shortId" AS "clientShortId",
      cl."fullName" AS "clientFullName", cl.phone AS "clientPhone", cl.kind AS "clientKind", cl.source AS "clientSource",
      cl."agentAttentionRequestedAt" AS "agentAttentionRequestedAt"
    FROM "BotConversation" c LEFT JOIN "Client" cl ON cl.id = c."clientId"
    LEFT JOIN "MessengerAccount" acc ON acc.id = c."accountId"
    WHERE (${channel ?? null}::text IS NULL OR c.channel = ${channel ?? null})
      AND (${accountId ?? null}::text IS NULL OR c."accountId" = ${accountId ?? null})
      AND (${like}::text IS NULL OR cl."fullName" ILIKE ${like} OR c.name ILIKE ${like} OR c.messages::text ILIKE ${like})
      AND (${botScope})
  ` : Prisma.sql`SELECT NULL::text AS id, NULL::text AS "sourceId", NULL::text AS kind, NULL::text AS channel,
      NULL::text AS name, NULL::text AS "subscriberId", NULL::text AS "accountId", NULL::text AS "accountTitle",
      NULL::timestamp AS "lastMessageAt", NULL::timestamp AS "readAt", NULL::timestamp AS "createdAt", NULL::timestamp AS "updatedAt",
      NULL::timestamp AS "pausedUntil", NULL::timestamp AS "botPausedAt", 0::int AS "messagesCount", NULL::jsonb AS "lastMessage",
      NULL::text AS "clientId", NULL::text AS "clientAssignedAgentId", NULL::int AS "clientShortId", NULL::text AS "clientFullName",
      NULL::text AS "clientPhone", NULL::text AS "clientKind", NULL::text AS "clientSource", NULL::timestamp AS "agentAttentionRequestedAt" WHERE FALSE`;
  const telegramRows = includeTelegram ? Prisma.sql`
    SELECT ${TG_PREFIX} || c.id AS id, ${TG_PREFIX} || c.id AS "sourceId", 'telegram'::text AS kind, ${TELEGRAM_CHANNEL}::text AS channel,
      CASE WHEN c.username IS NULL THEN NULL ELSE '@' || c.username END AS name, c."chatId" AS "subscriberId",
      NULL::text AS "accountId", NULL::text AS "accountTitle", c."lastMessageAt", c."readAt", c."createdAt", c."updatedAt",
      c."pausedUntil", c."botPausedAt", CASE WHEN jsonb_typeof(c.messages) = 'array' THEN jsonb_array_length(c.messages) ELSE 0 END AS "messagesCount",
      CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
      cl.id AS "clientId", cl."assignedAgentId" AS "clientAssignedAgentId", cl."shortId" AS "clientShortId",
      cl."fullName" AS "clientFullName", cl.phone AS "clientPhone", cl.kind AS "clientKind", cl.source AS "clientSource",
      cl."agentAttentionRequestedAt" AS "agentAttentionRequestedAt"
    FROM "TelegramConversation" c LEFT JOIN "Client" cl ON cl.id = c."clientId"
    WHERE (${like}::text IS NULL OR cl."fullName" ILIKE ${like} OR c.username ILIKE ${like} OR c.messages::text ILIKE ${like})
      AND (${ownAgentId ?? null}::text IS NULL OR (${ownClientScope}))
  ` : Prisma.sql`SELECT NULL::text AS id, NULL::text AS "sourceId", NULL::text AS kind, NULL::text AS channel,
      NULL::text AS name, NULL::text AS "subscriberId", NULL::text AS "accountId", NULL::text AS "accountTitle",
      NULL::timestamp AS "lastMessageAt", NULL::timestamp AS "readAt", NULL::timestamp AS "createdAt", NULL::timestamp AS "updatedAt",
      NULL::timestamp AS "pausedUntil", NULL::timestamp AS "botPausedAt", 0::int AS "messagesCount", NULL::jsonb AS "lastMessage",
      NULL::text AS "clientId", NULL::text AS "clientAssignedAgentId", NULL::int AS "clientShortId", NULL::text AS "clientFullName",
      NULL::text AS "clientPhone", NULL::text AS "clientKind", NULL::text AS "clientSource", NULL::timestamp AS "agentAttentionRequestedAt" WHERE FALSE`;
  const directRows = includeDirect ? Prisma.sql`
    SELECT 'td_' || c.id AS id, 'td_' || c.id AS "sourceId", 'telegram-direct'::text AS kind, 'TELEGRAM_DIRECT'::text AS channel,
      CASE WHEN c.username IS NULL THEN NULL ELSE '@' || c.username END AS name,
      c."chatId" || ':' || c."topicId" AS "subscriberId", NULL::text AS "accountId", NULL::text AS "accountTitle",
      c."lastMessageAt", c."readAt", c."createdAt", c."updatedAt", c."pausedUntil", NULL::timestamp AS "botPausedAt",
      CASE WHEN jsonb_typeof(c.messages) = 'array' THEN jsonb_array_length(c.messages) ELSE 0 END AS "messagesCount",
      CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
      cl.id AS "clientId", cl."assignedAgentId" AS "clientAssignedAgentId", cl."shortId" AS "clientShortId",
      cl."fullName" AS "clientFullName", cl.phone AS "clientPhone", cl.kind AS "clientKind", cl.source AS "clientSource",
      cl."agentAttentionRequestedAt" AS "agentAttentionRequestedAt"
    FROM "TelegramDirectConversation" c LEFT JOIN "Client" cl ON cl.id = c."clientId"
    WHERE (${like}::text IS NULL OR cl."fullName" ILIKE ${like} OR c.username ILIKE ${like} OR c.messages::text ILIKE ${like})
      AND (${ownAgentId ?? null}::text IS NULL OR (${ownClientScope}))
  ` : Prisma.sql`SELECT NULL::text AS id, NULL::text AS "sourceId", NULL::text AS kind, NULL::text AS channel,
      NULL::text AS name, NULL::text AS "subscriberId", NULL::text AS "accountId", NULL::text AS "accountTitle",
      NULL::timestamp AS "lastMessageAt", NULL::timestamp AS "readAt", NULL::timestamp AS "createdAt", NULL::timestamp AS "updatedAt",
      NULL::timestamp AS "pausedUntil", NULL::timestamp AS "botPausedAt", 0::int AS "messagesCount", NULL::jsonb AS "lastMessage",
      NULL::text AS "clientId", NULL::text AS "clientAssignedAgentId", NULL::int AS "clientShortId", NULL::text AS "clientFullName",
      NULL::text AS "clientPhone", NULL::text AS "clientKind", NULL::text AS "clientSource", NULL::timestamp AS "agentAttentionRequestedAt" WHERE FALSE`;

  type GroupedSourceRow = ListRow & {
    kind: "bot" | "telegram" | "telegram-direct";
    groupId: string;
    sourceIds: string[];
    channels: string[];
    groupMessagesCount: number;
    groupUnread: boolean;
    groupUnreadCount: number;
    awaitingHumanSince: Date | null;
    groupTotal: bigint;
    countAll: bigint;
    countNeedsHuman: bigint;
    countPaused: bigint;
    countMine: bigint;
  };
  const sourceRowsSql = Prisma.sql`${botRows} UNION ALL ${telegramRows} UNION ALL ${directRows}`;
  const now = new Date();
  const countRows = await prisma.$queryRaw<{ groupTotal: bigint; countAll: bigint; countNeedsHuman: bigint; countPaused: bigint; countMine: bigint }[]>(Prisma.sql`
    WITH source_rows AS (${sourceRowsSql}), keyed AS (
      SELECT s.*, CASE WHEN s."clientId" IS NOT NULL THEN 'client:' || s."clientId" ELSE 'source:' || s."sourceId" END AS "groupId",
        COALESCE(s."lastMessageAt", s."updatedAt") AS "activityAt",
        (s."lastMessage" ->> 'role') = 'user' AS "waitingUser",
        (s."pausedUntil" IS NOT NULL AND s."pausedUntil" > ${now}) AS "isPaused"
      FROM source_rows s
    ), grouped AS (
      SELECT "groupId", BOOL_OR("waitingUser") AS "waitingUser", BOOL_OR("isPaused") AS "isPaused",
        BOOL_OR("clientAssignedAgentId" = ${viewerAgentId}) AS "isMine"
      FROM keyed GROUP BY "groupId"
    )
    SELECT COUNT(*) AS "groupTotal", COUNT(*) FILTER (WHERE "waitingUser") AS "countNeedsHuman",
      COUNT(*) FILTER (WHERE "isPaused") AS "countPaused", COUNT(*) FILTER (WHERE "isMine") AS "countMine",
      COUNT(*) FILTER (WHERE (${segments.needsHuman ?? false}::boolean = FALSE OR "waitingUser")
        AND (${segments.paused ?? false}::boolean = FALSE OR "isPaused")
        AND (${segments.mine ?? false}::boolean = FALSE OR "isMine")) AS "countAll"
    FROM grouped
  `);
  const rows = await prisma.$queryRaw<GroupedSourceRow[]>(Prisma.sql`
    WITH source_rows AS (${sourceRowsSql}), keyed AS (
      SELECT s.*, CASE WHEN s."clientId" IS NOT NULL THEN 'client:' || s."clientId" ELSE 'source:' || s."sourceId" END AS "groupId",
        COALESCE(s."lastMessageAt", s."updatedAt") AS "activityAt",
        (s."lastMessage" ->> 'role') = 'user' AS "waitingUser",
        (s."pausedUntil" IS NOT NULL AND s."pausedUntil" > ${now}) AS "isPaused"
      FROM source_rows s
    ), grouped AS (
      SELECT "groupId", MAX("activityAt") AS "activityAt", BOOL_OR("agentAttentionRequestedAt" IS NOT NULL) AS attention,
        BOOL_OR("waitingUser") AS "waitingUser", BOOL_OR("isPaused") AS "isPaused",
        BOOL_OR("clientAssignedAgentId" = ${viewerAgentId}) AS "isMine",
        SUM("messagesCount")::int AS "groupMessagesCount", ARRAY_AGG(DISTINCT channel ORDER BY channel) AS channels,
        ARRAY_AGG("sourceId" ORDER BY "activityAt" DESC, "sourceId" DESC) AS "sourceIds",
        MAX("agentAttentionRequestedAt") AS "agentAttentionRequestedAt",
        MIN("activityAt") FILTER (WHERE "waitingUser") AS "awaitingHumanSince"
      FROM keyed GROUP BY "groupId"
    ), metrics AS (
      SELECT COUNT(*) AS "groupTotal", COUNT(*) FILTER (WHERE "waitingUser") AS "countNeedsHuman",
        COUNT(*) FILTER (WHERE "isPaused") AS "countPaused", COUNT(*) FILTER (WHERE "isMine") AS "countMine"
      FROM grouped
    ), selected AS (
      SELECT g.*, m."groupTotal", m."countNeedsHuman", m."countPaused", m."countMine",
        ROW_NUMBER() OVER (ORDER BY g.attention DESC, g."activityAt" DESC, g."groupId" DESC) AS rn
      FROM grouped g CROSS JOIN metrics m
      WHERE (${segments.needsHuman ?? false}::boolean = FALSE OR g."waitingUser")
        AND (${segments.paused ?? false}::boolean = FALSE OR g."isPaused")
        AND (${segments.mine ?? false}::boolean = FALSE OR g."isMine")
    ), page_groups AS (
      SELECT * FROM selected WHERE rn > ${(page - 1) * PAGE_SIZE} AND rn <= ${page * PAGE_SIZE}
    )
    SELECT k.*, p."groupId", p."sourceIds", p.channels, p."groupMessagesCount", p."groupTotal",
      p."waitingUser" AS "groupUnread", 0::int AS "groupUnreadCount", p."awaitingHumanSince",
      p."countNeedsHuman", p."countPaused", p."countMine",
      (SELECT COUNT(*) FROM selected) AS "countAll"
    FROM page_groups p JOIN keyed k ON k."groupId" = p."groupId"
    ORDER BY p.rn, k."activityAt" DESC, k."sourceId" DESC
  `);

  const groups = new Map<string, { sources: ListRow[]; meta: GroupedSourceRow }>();
  for (const row of rows) {
    const group = groups.get(row.groupId) ?? { sources: [], meta: row };
    group.sources.push(row);
    groups.set(row.groupId, group);
  }
  const pageRows = [...groups.values()];
  const unreadCounts = await loadUnreadCounts(pageRows.flatMap(({ sources }) => sources));
  const items = pageRows.map(({ sources, meta }) => {
    const latest = sources[0]!;
    const channels = [...new Set(meta.channels)].sort();
    const groupUnreadCount = sources.reduce((sum, source) => {
      const last = source.lastMessage && typeof source.lastMessage === "object" ? source.lastMessage : null;
      const lastAt = source.lastMessageAt ?? source.updatedAt;
      const unread = last?.role === "user" && (!source.readAt || lastAt.getTime() > source.readAt.getTime());
      return sum + (unread ? unreadCounts.get(source.id) ?? 1 : 0);
    }, 0);
    const row: GroupedInboxRow = {
      ...latest,
      id: meta.groupId.startsWith("client:") ? meta.groupId : latest.id,
      groupId: meta.groupId,
      channel: channels.length === 1 ? channels[0]! : "MULTI",
      channels: canSeeOrigin ? channels : [],
      sourceConversationIds: meta.sourceIds,
      messagesCount: Number(meta.groupMessagesCount),
      unread: sources.some((source) => {
        const last = source.lastMessage && typeof source.lastMessage === "object" ? source.lastMessage : null;
        const lastAt = source.lastMessageAt ?? source.updatedAt;
        return last?.role === "user" && (!source.readAt || lastAt.getTime() > source.readAt.getTime());
      }),
      unreadCount: groupUnreadCount,
      awaitingHumanSince: meta.awaitingHumanSince,
    };
    const present = presentListRow(row, canSeeOrigin, phonesAllowed, new Map());
    return { ...present, id: row.id, sourceConversationIds: row.sourceConversationIds, channels: row.channels, unread: row.unread, unreadCount: row.unreadCount };
  });
  const summary = countRows[0];
  const counts = summary ? {
    all: Number(summary.groupTotal), needsHuman: Number(summary.countNeedsHuman),
    paused: Number(summary.countPaused), mine: Number(summary.countMine),
  } : { all: 0, needsHuman: 0, paused: 0, mine: 0 };
  return { items, total: summary ? Number(summary.countAll) : 0, counts, truncated: false };
}

conversationsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = conversationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { q, page, channel, accountId, needsHuman, paused, mine, grouped } = parsed.data;

  // Список каналов для фильтра строится ИЗ ДАННЫХ: новый канал, подключённый
  // канал (Messenger и т.п.) появляется в фильтре автоматически.
  //
  // groupBy, а НЕ findMany({ distinct }): Prisma схлопывает distinct не в SQL, а
  // в памяти движка — то есть вычитывает всю таблицу переписок и только потом
  // оставляет десяток названий каналов. `select: { channel: true }` от этого не
  // спасает. Таблица самая быстрорастущая в проекте, а запрос идёт на КАЖДОЕ
  // открытие инбокса; groupBy уходит в SQL и возвращает ровно те же строки.
  const [distinctChannels, tgCount] = await Promise.all([
    prisma.botConversation.groupBy({ by: ["channel"] }),
    prisma.telegramConversation.count(),
  ]);
  const channels = [...new Set([...distinctChannels.map((c) => c.channel), ...(tgCount > 0 ? [TELEGRAM_CHANNEL] : [])])].sort();

  // Фильтр и поиск целиком в SQL — в приложение приезжает ровно одна страница.
  const ownAgentId = chatScopeAgentId(req);
  const viewerAgentId = req.agent!.id;
  const segments: SegmentFilters = { needsHuman: !!needsHuman, paused: !!paused, mine: !!mine, viewerAgentId };
  const canSeeOrigin = can(req, "clients.viewOrigin");
  const phonesAllowed = can(req, "clients.viewPhone");
  if (grouped) {
    const result = await loadGroupedInboxRows({
      channel, q, accountId, ownAgentId, viewerAgentId, page, segments, canSeeOrigin, phonesAllowed,
    });
    const directCount = accountId || (channel && channel !== "TELEGRAM_DIRECT")
      ? 0
      : await prisma.telegramDirectConversation.count({
          where: ownAgentId
            ? { client: { is: { assignedAgentId: ownAgentId, deletedAt: null, acceptedAt: { not: null } } } }
        : { OR: [{ clientId: null }, { client: { is: { deletedAt: null } } }] },
        });
    res.json({
      items: result.items,
      total: result.total,
      page,
      pageSize: PAGE_SIZE,
      channels: canSeeOrigin ? [...new Set([...channels, ...(directCount > 0 ? ["TELEGRAM_DIRECT"] : [])])].sort() : [],
      accounts: canSeeOrigin
        ? (await listAccounts()).filter((a) => a.enabled).map((a) => ({ id: a.id, title: a.title, channel: a.channel }))
        : [],
      counts: result.counts,
      groupedIncomplete: result.truncated,
      alerts: await loadInboxAlerts(ownAgentId, canSeeOrigin, phonesAllowed),
    });
    return;
  }
  const [rows, total, counts, alerts] = await Promise.all([
    loadPageCandidates(page, channel, q, accountId, ownAgentId, segments),
    countMatches(channel, q, accountId, ownAgentId, segments),
    // Счётчики срезов (`.seg .n`) — по тем же channel/accountId/q/ownAgentId, что
    // и список, но БЕЗ needsHuman/paused/mine самих: кнопки должны показывать,
    // сколько диалогов попадёт в КАЖДЫЙ срез, а не сколько их в уже выбранном.
    loadSegmentCounts(channel, q, accountId, ownAgentId, viewerAgentId),
    // Тихие строки сверху — не зависят от текущей вкладки (см. комментарий у
    // loadInboxAlerts), считаются один раз на страницу списка.
    loadInboxAlerts(ownAgentId, canSeeOrigin, can(req, "clients.viewPhone")),
  ]);

  // Фильтры «по каналу» и «по аккаунту» — это буквально список платформ, с которых
  // пишут клиенты. Агенту их не отдаём вовсе (решение владельца 17.08.2026): иначе
  // скрытый значок канала возвращается фильтром, а скрытое название аккаунта —
  // переключателем. Пустые списки интерфейс просто не рисует.

  // Непрочитанные числом считаются ПО СТРАНИЦЕ, уже после нарезки: один запрос
  // на двадцать строк вместо разворота jsonb у всех кандидатов (см. loadUnreadCounts).
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const unreadCounts = await loadUnreadCounts(pageRows);
  res.json({
    items: pageRows.map((r) => presentListRow(r, canSeeOrigin, phonesAllowed, unreadCounts)),
    total,
    page,
    pageSize: PAGE_SIZE,
    channels: canSeeOrigin ? channels : [],
    // Переключатель аккаунтов в «Сообщениях»: показываем только включённые —
    // выключенный аккаунт новых сообщений не приносит, и фильтр по нему пустой.
    accounts: canSeeOrigin
      ? (await listAccounts()).filter((a) => a.enabled).map((a) => ({ id: a.id, title: a.title, channel: a.channel }))
      : [],
    // Срезы «Все / Ждут человека / Бот на паузе / Мои» эталона messages.html.
    counts,
    alerts,
  });
});

/**
 * ОТКРЫТЫЙ ДИАЛОГ САМ СЕБЯ ПЕРЕЗАПРАШИВАЛ ПО КРУГУ (найдено 19.09.2026 по
 * жалобе владельца «мобильная версия тормозит и в чате странности»).
 *
 * Цепочка была замкнутая:
 *   1. GET /conversations/:id БЕЗУСЛОВНО писал `readAt: new Date()` и
 *      безусловно же публиковал `conversation.updated`;
 *   2. событие уходит держателю карточки и надзорным ролям — то есть в том
 *      числе ТОМУ, кто только что открыл диалог; отправителя рассылка не
 *      исключает;
 *   3. на фронте `conversation.updated` гасит ключи ["conversations"] и
 *      ["counters"] префиксно (lib/liveEvents.ts), а значит и ключ САМОГО
 *      открытого диалога ["conversations", id];
 *   4. активный запрос перезапрашивается → шаг 1.
 *
 * Круг замыкался примерно за 250 мс (окно склейки инвалидаций), и каждый
 * оборот — это запись в базу, рассылка события, двенадцать COUNT-ов счётчиков
 * и выгрузка ВСЕЙ переписки диалога. Пока агент читал чат, телефон молотил
 * этот круг без остановки: отсюда и «тормозит», и севшая батарея, и упёртый
 * потолок запросов.
 *
 * Лечение — не трогать `readAt`, когда он и так свежее последнего сообщения:
 * отметка «прочитано» существует ради синего индикатора, а индикатор считается
 * как `lastMessageAt > readAt` (см. unread выше и schema.prisma). Второе и
 * последующие открытия того же диалога менять нечего — значит и события нет,
 * и круг не замыкается. Побочно исчезает запись в БД на каждое чтение.
 */
function needsReadReceipt(c: { lastMessageAt: Date | null; readAt: Date | null }): boolean {
  if (!c.readAt) return true;
  return c.lastMessageAt !== null && c.lastMessageAt.getTime() > c.readAt.getTime();
}

conversationsRouter.post("/:id/link-client", requirePermission("messages.view"), requirePermission("clients.merge"),
  requirePermission("clients.viewAll"), async (req, res, next) => {
    const rawId = req.params.id;
    const id = rawId.startsWith(TG_PREFIX) ? rawId.slice(TG_PREFIX.length) : rawId;
    const parsed = conversationClientLinkSchema.safeParse(req.body);
    if (!z.string().uuid().safeParse(id).success || !parsed.success) {
      return res.status(400).json({ error: "Выберите клиента и подтвердите, что это один человек" });
    }
    try {
      const result = await linkConversationClient(rawId, parsed.data, req.agent!.id);
      void publishConversationUpdated(rawId.startsWith(TG_PREFIX) ? "telegram" : "bot", id);
      return res.json(result);
    } catch (err) {
      if (err instanceof ConversationClientLinkError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

conversationsRouter.get("/:id", requireAuth, async (req, res) => {
  const rawId = req.params.id;
  let conversation: UnifiedConversation | null = null;
  let profileName: string | null = null;

  if (rawId.startsWith(TG_PREFIX)) {
    const id = rawId.slice(TG_PREFIX.length);
    const tg = await prisma.telegramConversation.findUnique({ where: { id }, include: { client: clientSelect } });
    if (tg) {
      // Открытие диалога = прочитано: сбрасывает синий индикатор в списке.
      // Но ТОЛЬКО если он и правда горел — см. needsReadReceipt ниже.
      if (needsReadReceipt(tg)) {
        await prisma.telegramConversation.update({ where: { id }, data: { readAt: new Date() } });
        // Прочитано — синий индикатор обязан погаснуть и в остальных вкладках.
        void publishConversationUpdated("telegram", id);
      }
      conversation = fromTelegram(tg);
      profileName = conversation.name;
    }
  } else {
    const bot = await prisma.botConversation.findUnique({ where: { id: rawId }, include: { client: clientSelect } });
    if (bot) {
      if (needsReadReceipt(bot)) {
        await prisma.botConversation.update({ where: { id: bot.id }, data: { readAt: new Date() } });
        void publishConversationUpdated("bot", bot.id);
      }
      conversation = bot;
      profileName = bot.name;
    }
  }
  if (!conversation) return res.status(404).json({ error: "Диалог не найден" });

  /**
   * ОТКУДА ПРИШЁЛ КЛИЕНТ — ПО ПРАВУ (решение владельца 17.08.2026, lib/clientOrigin.ts).
   *
   * Здесь этого было ТРИ утечки сразу, и каждая по отдельности сводила запрет на
   * нет: канал (значок мессенджера), ник в имени и `profileName` — «имя из соцсети
   * как его прислал мессенджер», то есть ровно тот самый @ник. `subscriberId` тоже
   * закрываем: это идентификатор профиля в соцсети.
   */
  const canSeeOrigin = can(req, "clients.viewOrigin");
  const canSeePhoneDetail = can(req, "clients.viewPhone");
  const shown = withHiddenConversationOrigin(
    {
      channel: conversation.channel,
      // Имя диалога закрывает номер в имени тем же правом, что и clientPhone ниже.
      name: conversation.client?.fullName
        ? clientNamePhoneSafe(conversation.client.fullName, canSeePhoneDetail)
        : conversation.name ? clientNamePhoneSafe(conversation.name, canSeePhoneDetail) : null,
    },
    canSeeOrigin
  );

  /**
   * ПОЧЕМУ БОТ ЗАМОЛЧАЛ (17.09.2026, lib/outboundShield.ts).
   *
   * Пауза от щита — обычная `pausedUntil`, и без причины сотрудник видел бы
   * «бот на паузе» без единого намёка, кто её поставил и что делать. Причина
   * отдаётся сервером, а не выводится на фронте: тексты причин живут в одном
   * месте вместе с самими правилами.
   */
  const shieldTransport = await loadCustomerTransportForConversation(conversation.id);
  const shield = shieldTransport ? await shieldPauseFor(conversation.channel, conversation.subscriberId, undefined, shieldTransport) : null;

  /**
   * ДОСЬЕ СОБЕСЕДНИКА — ровно то, что бот прочитает перед следующим ответом.
   *
   * До этой правки досье существовало только на сервере: бот им пользовался, а
   * ни агент, ни владелец не могли увидеть, что там лежит, и понять, почему бот
   * отвечает именно так. `null` — досье ещё нет (диалог начат раньше, чем
   * досье появились) — панель на фронте об этом и пишет, а не молчит.
   */
  const contact = await contactProfileView(conversation.contactProfileId, {
    canSeeOrigin,
    canSeePhone: can(req, "clients.viewPhone"),
    canMerge: can(req, "clients.merge"),
  });

  res.json({
    id: conversation.id,
    channel: shown.channel,
    name: shown.name,
    /** Имя из соцсети как его прислал мессенджер — может отличаться от ФИО клиента в CRM. */
    profileName: canSeeOrigin && profileName ? clientNamePhoneSafe(profileName, canSeePhoneDetail) : null,
    /** ID подписчика в канале Meta или chat_id Telegram — единственный
     *  стабильный идентификатор профиля. */
    // WhatsApp wa_id is the sender's phone. Seeing the channel does not grant
    // permission to see that phone; keep the raw ID only for server delivery.
    subscriberId: !canSeeOrigin ? null : conversation.channel === "WHATSAPP"
      ? clientPhoneFor(conversation.subscriberId, canSeePhoneDetail)
      : conversation.subscriberId,
    clientId: conversation.client?.id ?? null,
    clientShortId: conversation.client?.shortId ?? null,
    // Телефон клиента — по праву clients.viewPhone (см. lib/clientPhone.ts). В инбоксе
    // он приходил целиком в обход правила, и закрытый номер в разделе «Клиенты» ничего
    // не давал: диалог показывал его рядом с именем.
    clientPhone: conversation.client?.phone
      ? clientPhoneFor(conversation.client.phone, can(req, "clients.viewPhone"))
      : null,
    firstContactAt: conversation.createdAt,
    pausedUntil: conversation.pausedUntil,
    /** Бот остановлен ЩИТОМ исходящих — причина и до какого времени. Снимается
     *  той же кнопкой «Вернуть боту» и сама, первым же сообщением человека. */
    shieldPause: shield ? { reason: shield.reason, reasonText: shield.reasonText, until: shield.until } : null,
    // Вложения приходят вместе с репликами, но имя файла — только тем, у кого есть
    // право их открывать (см. lib/messageAttachments.ts). Остальные видят текст как
    // раньше и понятную пометку на месте фото.
    //
    // Телефон в САМОМ ТЕКСТЕ реплики (клиент диктует номер прямо в переписке) —
    // тем же правом clients.viewPhone, что и структурное поле clientPhone выше.
    // Без этого право обходилось первой же репликой «мой номер...».
    messages: presentMessages(
      conversation.messages,
      can(req, "messages.viewAttachments"),
      can(req, "clients.viewPhone")
    ),
    /** Что бот знает о человеке вообще — см. lib/contactProfileView.ts. */
    contact,
  });
});

// Длительность паузы можно передать явно (кнопки-пресеты в инбоксе, см. PAUSE_OPTIONS
// на фронте) — если не передали, остаётся старое поведение по умолчанию (1 час).
const replySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  pausedUntil: z.string().datetime().optional(),
});

conversationsRouter.post("/:id/reply", requireAuth, async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const rawId = req.params.id;
  const isTelegram = rawId.startsWith(TG_PREFIX);

  // Диалог поднимаем ДО выбора транспорта: у диалогов бота транспорт зависит от
  // канала (WhatsApp/Instagram/Messenger уходят через Graph API самой Meta, всё
  // прочее — своими каналами), а канал известен только из записи.
  const conversation = isTelegram
    ? await prisma.telegramConversation.findUnique({ where: { id: rawId.slice(TG_PREFIX.length) } }).then((c) => c && fromTelegram({ ...c, client: null }))
    : await prisma.botConversation.findUnique({ where: { id: rawId }, include: { client: clientSelect } });
  if (!conversation) return res.status(404).json({ error: "Диалог не найден" });

  // Транспорт, пауза, маскировка телефонов и запись в историю — общий путь с отправкой
  // из карточки клиента (lib/conversationDelivery.ts). Канал Meta — единственный путь
  // ответа в WhatsApp, Instagram и Messenger: раньше его не было вовсе, отправка в эти
  // каналы жила только в обработчике вебхука и служила автоответам бота.
  const target = isTelegram
    ? ({ kind: "telegram", id: rawId.slice(TG_PREFIX.length), subscriberId: conversation.subscriberId } as const)
    : ({
        kind: "bot",
        id: conversation.id,
        channel: conversation.channel,
        subscriberId: conversation.subscriberId,
        // UnifiedConversation (ветка Telegram) этого поля не несёт — сюда мы не
        // попадаем, но тип у conversation общий на весь тернарник выше.
        accountId: "accountId" in conversation ? (conversation.accountId as string | null) : undefined,
      } as const);

  const delivery = await deliverToConversation(
    target,
    parsed.data.text,
    parsed.data.pausedUntil ? new Date(parsed.data.pausedUntil) : undefined,
    // Сотрудник вмешался в разговор бота — самый честный признак, что бот не
    // справился, а его собственный ответ и есть правильный (см. lib/botLessons.ts).
    { learnFromOverride: true, sender: await agentSender(req.agent!.id) }
  );
  if (!delivery.ok) {
    return res.status(delivery.status).json({ error: delivery.error, code: delivery.code });
  }

  // masked отдаём наружу: интерфейс показывает агенту, что номер был скрыт, —
  // иначе он решит, что клиент номер получил, и будет ждать звонка впустую.
  res.json({ ok: true, pausedUntil: delivery.pausedUntil, masked: delivery.masked });
});

const translateMessageSchema = z.object({ at: z.string().min(1) });

/**
 * Перевод ОДНОЙ реплики клиента на русский, по клику (13.09.2026) — тот же приём,
 * что и звонки (POST /interactions/:id/translate, см. routes/interactions.ts):
 * перевод не готов заранее, а считается, только когда сотрудник его запросил —
 * переписки на порядок больше, чем звонков, автоматический перевод каждой
 * таджикской реплики был бы той же ошибкой экономии токенов, что уже
 * исправляли 19.08.2026 для звонков, только дороже.
 *
 * ТОЛЬКО BotConversation (Instagram/WhatsApp/сайт). Telegram — отдельная таблица
 * и отдельный путь доставки; перевод для неё не реализован, честно отвечаем 400,
 * а не молчим и не притворяемся, что перевели.
 *
 * Право — общий гейт роутера (messages.view/messages.viewOwn, см. заголовок файла)
 * и скоуп по `.use("/:id", …)` выше: то же самое, что открывает саму переписку.
 * Перевод — чтение, не смена поведения бота, повышенное право (как у /pause) ему
 * не нужно.
 */
conversationsRouter.post("/:id/translate", requireAuth, async (req, res) => {
  const parsed = translateMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const rawId = req.params.id;
  if (rawId.startsWith(TG_PREFIX)) {
    return res.status(400).json({ error: "Перевод пока не поддержан для Telegram" });
  }

  const conversation = await prisma.botConversation.findUnique({
    where: { id: rawId },
    select: { id: true, messages: true },
  });
  if (!conversation) return res.status(404).json({ error: "Диалог не найден" });

  const messages = Array.isArray(conversation.messages)
    ? (conversation.messages as { role?: unknown; content?: unknown; at?: unknown }[])
    : [];
  // Ищем С КОНЦА: `at` не уникален железно (см. translateChatMessage.ts), а
  // реплика, которую сотрудник видит на экране, — самая свежая с этим штампом.
  const target = [...messages]
    .reverse()
    .find((m) => m.role === "user" && m.at === parsed.data.at && typeof m.content === "string");
  if (!target) return res.status(404).json({ error: "Реплика не найдена" });

  const { translateChatMessage } = await import("../messengers/translateChatMessage.js");
  const translated = await translateChatMessage(rawId, parsed.data.at, target.content as string);
  // Свежий перевод — по праву на телефон, как и сохранённый в presentMessages
  // (22.09.2026): клиент диктует номер в переписку, и кнопка «Перевести»
  // оставалась обходом запрета — тот же случай, что закрыт для расшифровок.
  res.json({ translatedRu: phoneSafeText(translated, can(req, "clients.viewPhone")) });
});

/**
 * Голосовое сообщение из инбокса (16.08.2026, Telegram — 19.08.2026): «всегда
 * писать неудобно» — та же причина, по которой агент получил кнопку записи
 * в интерфейсе. Транспорт (Meta/Telegram) выбирает deliverVoiceToConversation.
 */
conversationsRouter.post("/:id/reply-voice", requireAuth, anyParams(voiceMessageUpload.single("audio")), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });

  const rawId = req.params.id;
  const isTelegram = rawId.startsWith(TG_PREFIX);
  const conversation = isTelegram
    ? await prisma.telegramConversation.findUnique({ where: { id: rawId.slice(TG_PREFIX.length) }, include: { client: clientSelect } }).then((c) => c && fromTelegram({ ...c, client: c.client }))
    : await prisma.botConversation.findUnique({ where: { id: rawId }, include: { client: clientSelect } });
  if (!conversation) return res.status(404).json({ error: "Диалог не найден" });

  const target = isTelegram
    ? ({ kind: "telegram", id: rawId.slice(TG_PREFIX.length), subscriberId: conversation.subscriberId } as const)
    : ({
        kind: "bot",
        id: conversation.id,
        channel: conversation.channel,
        subscriberId: conversation.subscriberId,
        accountId: "accountId" in conversation ? (conversation.accountId as string | null) : undefined,
      } as const);

  const delivery = await deliverVoiceToConversation(target, { buffer: req.file.buffer }, {
    sender: await agentSender(req.agent!.id),
    clientId: conversation.client?.id ?? null,
    clientName: conversation.client?.fullName ?? conversation.name ?? null,
  });
  if (!delivery.ok) {
    return res.status(delivery.status).json({ error: delivery.error, blocked: delivery.blocked ?? false, code: delivery.code });
  }
  res.json({ ok: true, pausedUntil: delivery.pausedUntil });
});

/** Подпись к фото/видео — необязательна, тот же лимит длины, что и у обычного текста. */
const replyMediaCaptionSchema = z.object({
  caption: z.string().trim().max(1000).optional(),
});

/**
 * Фото/видео из инбокса (18.08.2026, Telegram — 19.08.2026) — тот же запрос
 * владельца, что и голосовые: «отправить фото/видео объекта клиенту прямо из
 * переписки». Транспорт (Meta/Telegram) выбирает deliverMediaToConversation.
 */
conversationsRouter.post("/:id/reply-media", requireAuth, anyParams(mediaMessageUpload.single("media")), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });

  const parsed = replyMediaCaptionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const rawId = req.params.id;
  const isTelegram = rawId.startsWith(TG_PREFIX);
  const conversation = isTelegram
    ? await prisma.telegramConversation.findUnique({ where: { id: rawId.slice(TG_PREFIX.length) } }).then((c) => c && fromTelegram({ ...c, client: null }))
    : await prisma.botConversation.findUnique({ where: { id: rawId }, include: { client: clientSelect } });
  if (!conversation) return res.status(404).json({ error: "Диалог не найден" });

  const target = isTelegram
    ? ({ kind: "telegram", id: rawId.slice(TG_PREFIX.length), subscriberId: conversation.subscriberId } as const)
    : ({
        kind: "bot",
        id: conversation.id,
        channel: conversation.channel,
        subscriberId: conversation.subscriberId,
        accountId: "accountId" in conversation ? (conversation.accountId as string | null) : undefined,
      } as const);

  // К9 (11.09.2026): mediaMessageUpload на diskStorage (upload.ts, до 300 МБ).
  // Файл передаётся ПУТЁМ и уходит в R2 частями: раньше он читался в память
  // целиком, и две-три отправки видео разом роняли API (аудит 23.09.2026, №74).
  // Временный файл убирается в любом исходе.
  /**
   * ОТВЕТ УХОДИТ ПОСЛЕ УБОРКИ (20.09.2026) — тем же приёмом, что у приёма
   * готового ролика в routes/properties/videos.ts. `res.json(...)` внутри try
   * означал ответ РАНЬШЕ `finally`, то есть отправитель видит успех, когда
   * временный файл ещё лежит на диске. Там на этом ловилась проверка каталога;
   * здесь отдельной проверки нет, но обещание кода («убираем временный файл в
   * любом исходе») одинаково должно быть правдой к моменту ответа, а не когда-то
   * после. Форма выбрана та же намеренно: два места с одним обещанием читаются
   * одинаково.
   */
  let outcome: { status: number; body: Record<string, unknown> };
  try {
    const delivery = await deliverMediaToConversation(
      target,
      { path: req.file.path, size: req.file.size, mimetype: req.file.mimetype, originalname: req.file.originalname },
      { sender: await agentSender(req.agent!.id), caption: parsed.data.caption }
    );
    outcome = delivery.ok
      ? { status: 200, body: { ok: true, pausedUntil: delivery.pausedUntil } }
      : { status: delivery.status, body: { error: delivery.error, code: delivery.code } };
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
  res.status(outcome.status).json(outcome.body);
});

/** Пауза/возврат бота работают для обеих таблиц — по префиксу id. */
async function setPausedUntil(rawId: string, pausedUntil: Date | null): Promise<boolean> {
  // botPausedAt — с какого момента НАЧАЛАСЬ эта пауза (шаг 5 переноса, 10.09.2026):
  // null снимает вместе с pausedUntil, дата — вместе с новой постановкой на паузу.
  const botPausedAt = pausedUntil ? new Date() : null;
  if (rawId.startsWith(TG_PREFIX)) {
    const id = rawId.slice(TG_PREFIX.length);
    const exists = await prisma.telegramConversation.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return false;
    await prisma.telegramConversation.update({ where: { id }, data: { pausedUntil, botPausedAt } });
    void publishConversationUpdated("telegram", id);
    return true;
  }
  const exists = await prisma.botConversation.findUnique({ where: { id: rawId }, select: { id: true } });
  if (!exists) return false;
  await prisma.botConversation.update({ where: { id: rawId }, data: { pausedUntil, botPausedAt } });
  void publishConversationUpdated("bot", rawId);
  return true;
}

/**
 * Поставить бота на паузу БЕЗ отправки сообщения — например, если оператор ещё
 * не ответил, но уже собирается разобраться с клиентом лично. Тот же контракт,
 * что и у /clients/:id/bot-pause (botPauseSchema) — pausedUntil=null снимает паузу.
 *
 * ТОЛЬКО messages.view, НЕ messages.viewOwn (найдено адверсариальной проверкой
 * мержа 07.09.2026). Владелец в тот же день запретил агентам решать судьбу
 * бота: «пусть это больше не решают агенты, а только админ и директор, и сам
 * ИИ решает, когда боту возвращаться». Раздел «Чаты» открыт агенту по
 * messages.viewOwn (см. заслон роутера выше), а эти два маршрута до сих пор
 * проверяли только requireAuth — общий гейт роутера пускал агента дальше, и
 * управление ботом молча вернулось бы туда, откуда его убрали в
 * feat/chat-like-social. Явная проверка права здесь нужна ИМЕННО потому, что
 * общий гейт роутера намеренно пускает оба права — это единственное место,
 * где им положено расходиться.
 */
conversationsRouter.post("/:id/pause", requireAuth, requirePermission("messages.view"), async (req, res) => {
  const parsed = botPauseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const pausedUntil = parsed.data.pausedUntil ? new Date(parsed.data.pausedUntil) : null;
  if (!(await setPausedUntil(req.params.id, pausedUntil))) {
    return res.status(404).json({ error: "Диалог не найден" });
  }
  res.json({ ok: true, pausedUntil });
});

/** «Вернуть боту» прямо из инбокса — снимает паузу, ИИ снова отвечает сам.
 *  Право то же и по той же причине, что у /pause выше. */
conversationsRouter.post("/:id/resume", requireAuth, requirePermission("messages.view"), async (req, res) => {
  if (!(await setPausedUntil(req.params.id, null))) {
    return res.status(404).json({ error: "Диалог не найден" });
  }
  res.json({ ok: true });
});

/**
 * ОЦЕНКА ОТВЕТА БОТА ПРЯМО В ЧАТЕ (17.09.2026).
 *
 * Владелец 17.09 разметил ответы бота на отдельных страницах — те правки сразу
 * пошли в промт. Тут то же самое, но без отдельного экрана «Обучение бота»:
 * нажал «Верно»/«Неверно» под пузырём ответа — и урок уходит в промт немедленно
 * (при «Неверно» с заметкой) или в очередь ночного разбора (без заметки).
 *
 * `bad` пишет прямо в `BotLesson` (не через `recordLesson()` — её дедуп по тексту
 * бота за 7 дней здесь мешает: два разных клиента могли получить одинаковый
 * неудачный ответ, а оценивает его человек за человеком, и каждая оценка должна
 * попасть в свою запись). `good` идёт через `rememberAgentReply()` с новым
 * источником `APPROVED` — источник у `StyleExample.source` в базе обычный String,
 * не enum, добавление значения миграции не требует (см. styleLearning.ts).
 *
 * Право — то же, что у `PATCH /bot-learning/:id` (`settings.manage`), но БЕЗ
 * `requireElevation`: там владелец меняет системный текст руками, здесь оценивает
 * уже случившийся ответ — не смена настроек, а разметка одного случая, ближе к
 * «взять диалог на себя» (`/reply`, тоже без повторного подтверждения личности).
 */
conversationsRouter.post("/:id/reply-feedback", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = replyFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { messageKey, verdict, note } = parsed.data;
  const rawId = req.params.id;

  try {
    // Логика вынесена в lib/replyFeedback.ts (17.09.2026, «Тренажёр бота»):
    // тренажёр оценивает те же ответы бота тем же способом, и без общего места
    // обе точки входа разошлись бы молча.
    const { feedback } = await applyReplyFeedback({ rawId, messageKey, verdict, note, userId: req.agent!.id });
    logAudit(
      req,
      verdict === "bad" ? "BOT_REPLY_FEEDBACK_BAD" : "BOT_REPLY_FEEDBACK_GOOD",
      rawId.startsWith(TG_PREFIX) ? "TelegramConversation" : "BotConversation",
      rawId.startsWith(TG_PREFIX) ? rawId.slice(TG_PREFIX.length) : rawId,
      { messageKey, hasNote: !!note }
    );
    res.json({ ok: true, feedback });
  } catch (err) {
    if (err instanceof ReplyFeedbackError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
