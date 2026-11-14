import type { PermissionId } from "@royal-home/shared";
import { maskPhonesForReader } from "@royal-home/shared";
import { prisma } from "../db.js";
import { investigationRoleFor } from "../auth/investigations.js";
import { visibleInteractionWhere } from "./investigationPrivacy.js";
import { clientNamePhoneSafe, phoneSafeText } from "./clientPhone.js";
import { activeLeadCounts, loadLeadLimits, NO_LEADS } from "./leadLimits.js";
import { runLimited } from "./concurrency.js";
import { activeCallFor } from "./telephony/callTracker.js";
import { liveIncomingCalls } from "./telephony/incomingCalls.js";
import { TG_PREFIX } from "./conversationId.js";
import { logSystemError } from "./systemError.js";

/**
 * «СЕЙЧАС» СОТРУДНИКА — ОДНА ДВЕРЬ (10.11.2026). Тело `GET /agents/:id/live`
 * (routes/team.ts) переехало сюда без изменений: его же читает помощница
 * (ai/assistant/tools/staffReadTools.ts), чтобы «кто сейчас в работе» в Telegram
 * и в карточке сотрудника считались одним кодом. null — сотрудника нет.
 *
 * Живой звонок читается из памяти процесса api (callTracker): из процесса worker
 * (Telegram) его не видно, поэтому помощница поле `call` не показывает вовсе.
 */
export interface StaffLiveViewer {
  role: string;
  can: (permission: PermissionId) => boolean;
}

/** Окно «онлайн»: сотрудник был в CRM последние три минуты. */
export const ONLINE_WINDOW_MS = 3 * 60 * 1000;

/** Строка сырого запроса по переписке — общая форма для BotConversation и
 *  TelegramConversation (см. GET /:id/live ниже). `lastMessage` разворачивает
 *  сама база (`messages -> -1`), поэтому здесь — уже последняя реплика, а не
 *  вся история. */
interface ChatRow {
  id: string;
  channel: string;
  lastMessageAt: Date;
  lastMessage: { role?: string; content?: string; by?: { kind?: string; agentName?: string } } | null;
  clientId: string;
  clientShortId: number;
  clientFullName: string;
}

/**
 * Своя ручка — свой потолок соединений. Меньше, чем у /overview (4): та уже
 * держит четыре, и открытие карточки зовёт обе одновременно — 3 + 4 = 7 при
 * пуле 15 оставляет запас остальным экранам (см. AGENT_OVERVIEW_QUERY_CONCURRENCY
 * выше и docs/sections-not-loading-19-09.md).
 */
const AGENT_LIVE_QUERY_CONCURRENCY = 3;

/**
 * «Сейчас» + «с кем общается» + «звонки за неделю» — верх карточки сотрудника
 * (владелец 20.09.2026: «чтобы быстро найти проблему»). Намеренно ОТДЕЛЬНАЯ
 * ручка от /overview, а не новые поля в ней: /overview уже держит 20 веток под
 * своим runLimited, пять из них — общекомандные хелперы антифрода по 2-4 запроса
 * каждый, и именно её уже один раз чинили за то, что она выедала пул соединений
 * (docs/sections-not-loading-19-09.md). Верх экрана обязан рисоваться быстро,
 * тяжёлый разбор проблем догружается вторым запросом — см. docs/archive/employee-card-brief-20-09.md §2.1.
 */
export async function loadStaffLive(id: string, viewer: StaffLiveViewer) {
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: { id: true, fullName: true, sipExtension: true, lastSeenAt: true },
  });
  if (!agent) return null;

  const viewerRole = investigationRoleFor(viewer.role, viewer.can("clients.securityReview"));
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const canSeePhone = viewer.can("clients.viewPhone");
  const canHear = viewer.can("calls.hearRecording");

  const [session, nextTask, botChats, tgChats, callBuckets, missedIncoming, lastCalls, statusRows, loadCounts, limits, unaccepted] =
    await runLimited(
      [
        // 1) Устройство и когда последний раз был.
        () =>
          prisma.session.findFirst({
            where: { agentId: id, revokedAt: null },
            orderBy: { lastSeenAt: "desc" },
            select: { device: true, lastSeenAt: true },
          }),
        // 2) Ближайшая задача/показ. subjectAgentId ?? agentId (П-10): задача,
        // заведённая ботом/системой от лица держателя карточки (agentId: null),
        // остаётся ЕГО задачей — тот же приём, что overdueTasksAgentWhere выше.
        () =>
          prisma.interaction.findFirst({
            where: {
              OR: [{ agentId: id }, { subjectAgentId: id }],
              ...visibleInteractionWhere(viewerRole),
              nextAction: { not: null },
              nextActionDate: { gte: now },
              completedAt: null,
              declinedAt: null,
              client: { deletedAt: null },
            },
            orderBy: { nextActionDate: "asc" },
            select: {
              id: true,
              type: true,
              nextAction: true,
              nextActionDate: true,
              client: { select: { id: true, shortId: true, fullName: true } },
            },
          }),
        // 3) и 4) Переписка — по образцу loadPageCandidates в routes/conversations.ts:
        // последнюю реплику разворачивает БАЗА (messages -> -1), а не Node, иначе на
        // каждую карточку в память приезжают все переписки целиком. jsonb_typeof
        // обязателен: у части старых строк messages не массив, jsonb_array_length на
        // них падает. LIMIT 8, сортировка по lastMessageAt (индекс есть у обеих таблиц).
        // TelegramDirectConversation НЕ включаем: инбокс «Сообщения» её не показывает,
        // и ссылка /messages?open=… вела бы в никуда.
        () =>
          prisma.$queryRaw<ChatRow[]>`
      SELECT c.id, c.channel, c."lastMessageAt",
             CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
             cl.id AS "clientId", cl."shortId" AS "clientShortId", cl."fullName" AS "clientFullName"
      FROM "BotConversation" c
      JOIN "Client" cl ON cl.id = c."clientId"
      WHERE cl."assignedAgentId" = ${id} AND cl."deletedAt" IS NULL
        AND c."lastMessageAt" IS NOT NULL
      ORDER BY c."lastMessageAt" DESC
      LIMIT 8`,
        () =>
          prisma.$queryRaw<ChatRow[]>`
      SELECT ${TG_PREFIX} || c.id AS id, 'TELEGRAM' AS channel, c."lastMessageAt",
             CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1 ELSE NULL END AS "lastMessage",
             cl.id AS "clientId", cl."shortId" AS "clientShortId", cl."fullName" AS "clientFullName"
      FROM "TelegramConversation" c
      JOIN "Client" cl ON cl.id = c."clientId"
      WHERE cl."assignedAgentId" = ${id} AND cl."deletedAt" IS NULL
        AND c."lastMessageAt" IS NOT NULL
      ORDER BY c."lastMessageAt" DESC
      LIMIT 8`,
        // 5) Звонки за неделю — одним groupBy, а не тремя count.
        () =>
          prisma.interaction.groupBy({
            by: ["callAttempt"],
            where: { agentId: id, type: "CALL", createdAt: { gte: weekAgo }, client: { deletedAt: null }, ...visibleInteractionWhere(viewerRole) },
            _count: { _all: true },
          }),
        // 6) Пропущенные ЕМУ входящие за неделю.
        () =>
          prisma.incomingCall.count({
            where: {
              startedAt: { gte: weekAgo },
              answered: false,
              OR: [{ routedToId: id }, { callbackAgentId: id }],
            },
          }),
        // 7) Последние разговоры с записью или расшифровкой — тот же where, что у
        // раздела «Звонки» (routes/calls.ts): без записи и без расшифровки слушать
        // и читать нечего.
        () =>
          prisma.interaction.findMany({
            where: {
              agentId: id,
              type: "CALL",
              ...visibleInteractionWhere(viewerRole),
              client: { deletedAt: null },
              OR: [{ recordingUrl: { not: null } }, { transcript: { not: null } }],
            },
            orderBy: { createdAt: "desc" },
            take: 6,
            select: {
              id: true,
              createdAt: true,
              recordingUrl: true,
              recordingDurationSec: true,
              callAttempt: true,
              outcome: true,
              client: { select: { id: true, shortId: true, fullName: true } },
              callAnalysis: { select: { score: true, agreedNextStep: true } },
            },
          }),
        // 8) Портфель по этапам.
        () =>
          prisma.client.groupBy({
            by: ["status"],
            where: { assignedAgentId: id, deletedAt: null },
            _count: { _all: true },
          }),
        // 9) и 10) Нагрузка и лимит — теми же хелперами, что решают раздачу лидов;
        // считать иначе нельзя, иначе полоса «у лимита» разойдётся с тем, что реально
        // останавливает раздачу.
        () => activeLeadCounts([id]),
        () => loadLeadLimits(),
        // 11) Выдано, но не принято.
        () => prisma.client.count({ where: { assignedAgentId: id, deletedAt: null, acceptedAt: null } }),
      ],
      AGENT_LIVE_QUERY_CONCURRENCY
    );

  // Живой звонок — ИЗ ПАМЯТИ, после запросов, без обхода к базе. callTracker —
  // карта в памяти процесса api, звонок туда попадает только когда его начали
  // ЧЕРЕЗ CRM. Нет записи — call: null, и экран пишет «не на звонке», а НЕ
  // «звонков нет» — не подменять это догадкой по свежему Interaction.
  //
  // Отказ телефонии не должен ронять карточку сотрудника (§2.5 задания):
  // станцию (listEndpoints) не опрашиваем вовсе, а activeCallFor/liveIncomingCalls
  // читают только память процесса, но обёрнуты на случай непредвиденного отказа.
  let live: ReturnType<typeof activeCallFor> | undefined;
  let incoming: ReturnType<typeof liveIncomingCalls>[number] | null = null;
  try {
    live = activeCallFor(id);
    incoming = agent.sipExtension
      ? liveIncomingCalls().find((c) => c.answeredBy === agent.sipExtension && c.answeredAt) ?? null
      : null;
  } catch (err) {
    await logSystemError("telephony", `Карточка сотрудника: не удалось прочитать живой звонок агента ${id}: ${err instanceof Error ? err.message : String(err)}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    live = undefined;
    incoming = null;
  }

  // Переписка — слить, отсортировать, обрезать.
  const chats = [...botChats, ...tgChats]
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
    .slice(0, 6)
    .map((c) => {
      const m = c.lastMessage;
      const text = m?.content ?? "";
      return {
        conversationId: c.id,
        channel: c.channel,
        client: { id: c.clientId, shortId: c.clientShortId, fullName: clientNamePhoneSafe(c.clientFullName, canSeePhone) },
        lastMessageAt: c.lastMessageAt,
        // Кто говорил последним: "client" — пишет человек и ждёт ответа,
        // "agent" — ответил сам сотрудник, "bot" — ответил бот за него.
        lastFrom: m?.role === "user" ? "client" : m?.by?.kind === "agent" ? "agent" : "bot",
        // Номер в тексте маскируется тем же правилом, что в инбоксе (см.
        // routes/conversations.ts, presentListRow): право читать переписку и право
        // видеть телефон — разные. maskPhones() задания принимает только текст —
        // как и на инбоксе, скрытие включаем/выключаем через выбор ветки, а не
        // второй параметр, которого у функции нет.
        // Маскируем ДО обрезки: обрезка на 140-м знаке может разрубить номер пополам,
        // и оставшаяся половина перестанет быть номером для маски.
        lastText: (canSeePhone ? text : maskPhonesForReader(text).text).slice(0, 140),
      };
    });

  return {
    now: {
      online: !!agent.lastSeenAt && Date.now() - agent.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
      lastSeenAt: agent.lastSeenAt,
      device: session?.device ?? null,
      call: live
        ? {
            direction: "out",
            clientId: live.clientId,
            clientShortId: live.clientShortId,
            clientName: live.clientName ? clientNamePhoneSafe(live.clientName, canSeePhone) : live.clientName,
            state: live.state,
            startedAt: live.startedAt,
            answeredAt: live.answeredAt ?? null,
          }
        : incoming
          ? {
              direction: "in",
              clientId: null,
              clientShortId: incoming.clientShortId ?? null,
              clientName: incoming.clientName ? clientNamePhoneSafe(incoming.clientName, canSeePhone) : null,
              state: "talking",
              startedAt: null,
              answeredAt: incoming.answeredAt ?? null,
            }
          : null,
      nextTask: nextTask && {
        id: nextTask.id,
        type: nextTask.type,
        title: canSeePhone ? nextTask.nextAction : phoneSafeText(nextTask.nextAction, false),
        at: nextTask.nextActionDate,
        client: nextTask.client ? { ...nextTask.client, fullName: clientNamePhoneSafe(nextTask.client.fullName, canSeePhone) } : nextTask.client,
      },
    },
    leads: {
      inWork: (loadCounts.get(id) ?? NO_LEADS).total,
      limit: limits.activeLimit, // 0 = раздача без предела, полосу не рисуем
      unaccepted,
      byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r._count._all])),
    },
    chats,
    calls: {
      weekTotal: callBuckets.reduce((s, b) => s + b._count._all, 0),
      weekTalked: callBuckets.find((b) => b.callAttempt === "TALKED")?._count._all ?? 0,
      weekMissedIncoming: missedIncoming,
      // Может ли ИМЕННО ЭТОТ смотрящий послушать звук — отдельное право от
      // чтения расшифровки (calls.hearRecording, владелец 04.09.2026).
      canHear,
      last: lastCalls.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        // Наружу — ФАКТ записи, а не ключ в R2: ссылку подписывают на 10 минут в
        // момент клика (lib/r2Client.ts), постоянный путь наружу не уходит.
        hasRecording: !!c.recordingUrl,
        durationSec: c.recordingDurationSec,
        callAttempt: c.callAttempt,
        outcome: c.outcome,
        client: c.client ? { ...c.client, fullName: clientNamePhoneSafe(c.client.fullName, canSeePhone) } : c.client,
        score: c.callAnalysis?.score ?? null,
        // agreedNextStep — булев флаг «договорились о следующем шаге», не текст:
        // маскировать нечего.
        agreedNextStep: c.callAnalysis?.agreedNextStep ?? null,
      })),
    },
  };
}
