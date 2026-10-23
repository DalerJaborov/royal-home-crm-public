/**
 * Запросы «соедините с оператором» — запись, очередь и закрытие.
 *
 * Тот же принцип, что у вопросов собственнику (lib/ownerQuestions.ts): обещание
 * бота превращается в запись, круг замыкает код. Разница в темпе: вопрос
 * собственнику может подождать часы, просьба о звонке остывает за минуты —
 * поэтому запись сопровождается push сразу всем, кто работает с сообщениями.
 *
 * Звонит агент из CRM (наборщик в браузере / originate уже есть): автоматически
 * соединять клиента с случайным агентом без его согласия нельзя — тот может быть
 * на показе, а сорванный звонок хуже звонка через три минуты.
 */

import { prisma } from "../db.js";
import { requestPultSnapshot } from "./pultCacheHook.js";
import type { CallbackRequest } from "../generated/prisma/client.js";
import { isReadOnlyRole, parsePermissionOverrides, resolvePermissions, type Role, type CallbackRequestView } from "@royal-home/shared";
export type { CallbackRequestView } from "@royal-home/shared";
import { ownBotConversationSql } from "./ownBotConversationScope.js";
import { logSystemError } from "./systemError.js";
import { logTimelineMany } from "./timeline.js";
import { describeError } from "./describeError.js";
import { findAgentsWithPermission } from "./recipients.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "./clientPhone.js";
import { extractVolunteeredPhone } from "../ai/leadQualifier.js";
import { clientAskedForOperator } from "../ai/operatorHandoff.js";
import { sendPushToAgent } from "../push.js";
import {
  AUTO_CONNECT_MAX_AGE_MS,
  connectCallbackToOperator,
  isOperatorCallbackChannel,
} from "./telephony/callbackConnect.js";

/**
 * ПРОСЬБА О ЗВОНКЕ ИЗ ПЕРЕПИСКИ — КУДА ЕЙ ИДТИ (владелец 22.09.2026).
 *
 * Оператору (дежурному, callbackOperatorAgentId) идут ТОЛЬКО прямые входящие на
 * городской. Всё из соцсетей/мессенджеров — агентам:
 *  • у карточки есть назначенный агент — запись в очереди и пуш ему, без АТС;
 *  • агента нет — false: вызывающий кладёт тему в черновик заявки, и она едет в
 *    раздачу агентам тем же путём, что при выключенном рубильнике.
 */
export async function routeMessengerCallbackRequest(input: {
  conversationId: string;
  clientId: string | null;
  channel: string;
  topic: string;
}): Promise<boolean> {
  if (!input.clientId) return false;
  const client = await prisma.client
    .findFirst({ where: { id: input.clientId, deletedAt: null }, select: { assignedAgentId: true } })
    .catch((err) => {
      void logSystemError("ai", `Обратный звонок: агент клиента не прочитан: ${describeError(err)}`);
      return null;
    });
  if (!client?.assignedAgentId) return false;
  await recordCallbackRequest({ ...input, targetAgentId: client.assignedAgentId, autoConnect: false });
  return true;
}

/** Не чаще одного пуша по одному диалогу за это время: «оператор?» три раза подряд —
 *  одна просьба, а не три. */
export const HUMAN_ASK_PUSH_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * КЛИЕНТ В ПЕРЕПИСКЕ ПРЯМО ПРОСИТ ЖИВОГО ЧЕЛОВЕКА — ОДИН ПУШ (владелец 24.09.2026).
 *
 * Плашку «Клиент просит звонок» владелец убрал совсем («мне не нужна просьба
 * позвонить и плашка» — её видели директор и админ, хотя звонить должен агент), но
 * попросил не терять настоящие просьбы: «если вдруг реально кто-то просит оператора
 * или живого человека, пуш подключить, чтоб сбоев не было».
 *
 * Порог — clientAskedForOperator (ai/operatorHandoff.ts): «соедините с оператором»,
 * «хочу с человеком». «Перезвоните» и оставленный номер сюда не проходят — это
 * обычная заявка агенту, как и раньше.
 *
 * Адресат: агент клиента, если он назначен (клиент с агентом к оператору не
 * попадает, правило 22.09.2026), иначе дежурный оператор (Настройки → Бот). Никого —
 * пуша нет, а просьба всё равно едет заявкой в раздачу. Руководству «к сведению»
 * не уходит никогда. От рубильника «Соединять с оператором» не зависит: он решает,
 * набирает ли АТС, а не терять ли просьбу. Станция здесь не набирает никого.
 *
 * Отметка — запись CallbackRequest того же диалога: по ней не шлём второй пуш в
 * окне HUMAN_ASK_PUSH_WINDOW_MS. Автодозвон её не возьмёт (канал не АТС, см.
 * callbackConnect.ts), а плашки, где она была бы видна, больше нет.
 *
 * Не бросает: ход диалога важнее уведомления.
 */
export async function notifyHumanAsk(input: {
  conversationId: string;
  clientId: string | null;
  channel: string;
  topic: string;
  clientText: string | null | undefined;
}): Promise<"sent" | "not_asked" | "duplicate" | "no_recipient" | "failed"> {
  if (!input.clientText || !clientAskedForOperator([input.clientText])) return "not_asked";
  try {
    const recent = await prisma.callbackRequest.findFirst({
      where: {
        conversationId: input.conversationId,
        requestedAt: { gte: new Date(Date.now() - HUMAN_ASK_PUSH_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return "duplicate";

    const [client, settings] = await Promise.all([
      input.clientId
        ? prisma.client.findFirst({
            where: { id: input.clientId, deletedAt: null },
            select: { assignedAgentId: true },
          })
        : null,
      prisma.settings.findUnique({ where: { id: "singleton" }, select: { callbackOperatorAgentId: true } }),
    ]);
    const agentId = client?.assignedAgentId ?? settings?.callbackOperatorAgentId ?? null;
    if (!agentId) return "no_recipient";

    const phone = await volunteeredPhoneFromConversation(input.conversationId);
    await prisma.callbackRequest.create({
      data: {
        conversationId: input.conversationId,
        clientId: input.clientId,
        channel: input.channel,
        phone,
        topic: input.topic.trim().slice(0, 500),
        byClientRequest: true,
      },
    });
    await sendPushToAgent(agentId, {
      title: "🙋 Клиент просит живого человека",
      body: `${input.topic}${phone ? ` Телефон: ${phone}` : " Телефона пока нет — спросите в переписке."}`,
      url: input.clientId ? `/clients/${input.clientId}` : "/messages",
    });
    return "sent";
  } catch (err) {
    void logSystemError("ai", `Просьба о живом человеке: пуш не отправлен: ${describeError(err)}`);
    return "failed";
  }
}


/**
 * НОМЕР, КОТОРЫЙ ЧЕЛОВЕК НАЗВАЛ САМ В ЭТОЙ ЖЕ ПЕРЕПИСКЕ (21.09.2026).
 *
 * Зачем: до этой правки запрос на звонок почти всегда создавался БЕЗ телефона —
 * вызывающий его не передавал, а карточки клиента у написавшего обычно ещё нет.
 * Соединение из-за этого возвращало «no_phone» и не набиралось вовсе: дежурный
 * видел баннер и звонил руками, хотя номер лежал в переписке выше.
 *
 * Берём ТОЛЬКО номер, НАЗВАННЫЙ САМИМ ЧЕЛОВЕКОМ (extractVolunteeredPhone, правило
 * строгое). wa_id сюда не годится НИКОГДА — это отдельные грабли 01.08.2026:
 * владелец написал боту со своего WhatsApp, и карточка получила американский
 * номер, по которому ему никто не звонит. Вместе с номером из wa_id теряется и
 * согласие: согласием служит сам факт, что человек продиктовал номер.
 *
 * Свежие сообщения раньше старых: если человек поправил номер, звонить надо по
 * последнему.
 */
async function volunteeredPhoneFromConversation(conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null;
  try {
    // Диалог может лежать в любой из трёх таблиц: у Telegram и у Direct Messages
    // свои (conversationId здесь — id той таблицы, из которой пришла просьба).
    const [meta, telegram, direct] = await Promise.all([
      prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } }),
      prisma.telegramConversation.findUnique({ where: { id: conversationId }, select: { messages: true } }),
      prisma.telegramDirectConversation.findUnique({ where: { id: conversationId }, select: { messages: true } }),
    ]);
    const raw = (meta ?? telegram ?? direct)?.messages;
    if (!Array.isArray(raw)) return null;
    const messages = raw as { role?: string; content?: string }[];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.role !== "user" || typeof message.content !== "string") continue;
      const phone = extractVolunteeredPhone(message.content);
      if (phone) return phone;
    }
    return null;
  } catch (err) {
    // Номер — это улучшение, а не условие записи: запрос всё равно попадёт в
    // очередь и будет виден в баннере.
    void logSystemError("ai", `Обратный звонок: номер из переписки не прочитан: ${describeError(err)}`);
    return null;
  }
}

const LIVE_VOICE_CHANNEL = "LIVE_VOICE";
/** Окно, в котором повторная эскалация живого голоса за того же человека не плодит запись и пуш. */
export const LIVE_VOICE_ESCALATION_DEDUPE_MS = 10 * 60_000;

export async function recordCallbackRequest(input: {
  conversationId?: string | null;
  clientId?: string | null;
  channel: string;
  phone?: string | null;
  topic: string;
  /**
   * ЛОЖНЫЙ ПЕРЕВОД НА ОПЕРАТОРА СРЕДИ ЖИВОГО ЗВОНКА (13.09.2026, найдено
   * владельцем на первом же тестовом звонке живого голоса). По умолчанию true —
   * это верно для переписки: клиент написал и ждёт, соединить с дежурным сразу
   * уместно. Но для звонка живым голосом (liveVoiceBridge.ts: save_contact)
   * клиент в этот момент УЖЕ разговаривает с ботом по телефону — тот же
   * originateCall на его номер набирает вторую, отдельную ветку на тот же
   * телефон, пока первая ещё идёт, и это выглядит как самопроизвольное
   * «переключение на агента» посреди разговора, которого никто не просил.
   * Live-голос передаёт false: заявка попадает в очередь и агент перезвонит
   * ПОСЛЕ того, как разговор с ботом закончится, — как и задумано.
   */
  autoConnect?: boolean;
  /**
   * Кому адресована просьба (22.09.2026). Задан — пуш только ему, и дежурный
   * оператор не участвует вовсе: так приходят просьбы из переписки, которые
   * владелец отдал агенту клиента (см. routeMessengerCallbackRequest).
   */
  targetAgentId?: string | null;
  /**
   * КЛИЕНТ САМ ПОПРОСИЛ ЖИВОГО ЧЕЛОВЕКА — ВТОРОЙ РУБЕЖ ТОГО ЖЕ ПРАВИЛА
   * (владелец 22.09.2026: «я отвечаю только неизвестным входящим звонкам и тем,
   * кто прямо просит поговорить с оператором лично»).
   *
   * Первый рубеж стоит у вызывающих в переписке (ai/operatorHandoff.ts): без
   * просьбы клиента они сюда просто не доходят. Этот — здесь, потому что
   * вызывающих четыре и два из них не переписка вовсе: `save_contact` живого
   * голоса заводит заявку по итогу разговора с ботом, а не по просьбе о
   * человеке. Дежурный оператор — последняя инстанция для того, кто просил
   * человека; «боту нужно, чтобы кто-то перезвонил» — обычная работа агентов,
   * и поднимать ею трубку дежурного нельзя.
   *
   * false (умолчание) — пуш уходит тем, кто работает с сообщениями, и
   * автодозвона нет. Запись в очереди появляется в обоих случаях: терять
   * просьбу нельзя ни при каком пороге.
   */
  byClientRequest?: boolean;
}): Promise<void> {
  const byClientRequest = input.byClientRequest ?? false;
  try {
    // Номер: переданный вызывающим, иначе названный самим человеком в переписке
    // (см. volunteeredPhoneFromConversation выше). Без него соединение не
    // набиралось вовсе, хотя номер лежал сообщением выше.
    const phone =
      input.phone?.trim() || (await volunteeredPhoneFromConversation(input.conversationId));
    // ЭСКАЛАЦИЯ ЖИВОГО ГОЛОСА — ОДНА НА ЗВОНЯЩЕГО В ОКНЕ (02.10.2026, аудит инструментов).
    // Модель может вызвать «позови человека» несколько раз за звонок, а человек
    // перезвонить и повторить: каждый раз новая запись и новый пуш дежурному. Тот же
    // человек (карточка или номер) в течение LIVE_VOICE_ESCALATION_DEDUPE_MS — одна просьба.
    // ПРОВЕРКА И ЗАПИСЬ — В ОДНОЙ ТРАНЗАКЦИИ ПОД БЛОКИРОВКОЙ ЗВОНЯЩЕГО (третий аудит
    // робота 02.10.2026, п.17): два параллельных вызова (модель позвала функцию дважды в
    // одном ходу) оба не находили свежую запись и оба её создавали. Ключ блокировки —
    // карточка либо номер, тот же человек сериализуется, разные — нет.
    const dedupeKey = input.clientId ?? phone;
    const dedupe = input.channel === LIVE_VOICE_CHANNEL && byClientRequest && !!dedupeKey;
    const data = {
      conversationId: input.conversationId ?? null,
      clientId: input.clientId ?? null,
      channel: input.channel,
      phone: phone || null,
      topic: input.topic.trim().slice(0, 500),
      byClientRequest,
    };
    const row = dedupe
      ? await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`callback-request:${dedupeKey}`})::bigint)`;
          const recent = await tx.callbackRequest.findFirst({
            where: {
              channel: LIVE_VOICE_CHANNEL,
              byClientRequest: true,
              doneAt: null,
              requestedAt: { gte: new Date(Date.now() - LIVE_VOICE_ESCALATION_DEDUPE_MS) },
              OR: [...(input.clientId ? [{ clientId: input.clientId }] : []), ...(phone ? [{ phone }] : [])],
            },
            select: { id: true },
          });
          return recent ? null : tx.callbackRequest.create({ data });
        })
      : await prisma.callbackRequest.create({ data });
    if (!row) return;
    requestPultSnapshot(); // пульт: новый запрос «перезвоните»

    /**
     * Push: дежурному оператору, если он назначен, иначе всем работающим с
     * сообщениями. Просьба о звонке остывает за минуты, и уведомление о ней —
     * не рассылка «кто-нибудь гляньте», а задача конкретному человеку.
     * Отказ рассылки не отменяет записи — очередь на экране остаётся.
     */
    // Дежурного зовём, только если сошлись ОБА условия владельца 22.09.2026:
    // клиент прямо попросил живого человека (byClientRequest) И просьба пришла с
    // АТС (isOperatorCallbackChannel — соцсети и мессенджеры не набирают его
    // никогда). Адресная просьба агенту клиента дежурного не касается вовсе.
    const operatorEligible =
      byClientRequest && isOperatorCallbackChannel(input.channel) && !input.targetAgentId;
    const settings = operatorEligible
      ? await prisma.settings
          .findUnique({ where: { id: "singleton" }, select: { callbackOperatorAgentId: true } })
          .catch(() => null)
      : null;
    const agentIds = input.targetAgentId
      ? [input.targetAgentId]
      : settings?.callbackOperatorAgentId
        ? [settings.callbackOperatorAgentId]
        : await findAgentsWithPermission("messages.view");
    const phoneNote = row.phone ? ` Телефон: ${row.phone}` : " Телефона пока нет — спросите в переписке.";
    await Promise.allSettled(
      agentIds.map((agentId) =>
        sendPushToAgent(agentId, {
          title: "📞 Клиент просит звонок",
          body: `${row.topic}${phoneNote}`,
          // Живой голос без карточки — в журнал звонков, а не в переписку (там его нет).
          url: row.clientId ? `/clients/${row.clientId}` : row.channel === LIVE_VOICE_CHANNEL ? "/calls" : "/messages",
        })
      )
    );

    // В рабочее время соединяем СРАЗУ (решение владельца 16.08.2026): трубка
    // дежурного зазвонит через секунды после ответа бота. Вне рабочего времени и
    // при любом сбое запрос просто остаётся в очереди — его подхватит крон утром.
    // Кроме звонков живым голосом (autoConnect: false, см. докстринг параметра) —
    // там клиент уже говорит по телефону, соединять его номер второй раз нельзя.
    // Автодозвон дежурного — по тем же двум условиям, что и выбор получателя пуша
    // выше: просьба самого клиента и канал АТС. Всё прочее — обычная заявка агенту.
    if (operatorEligible && (input.autoConnect ?? true)) void connectCallbackToOperator(row.id);
  } catch (err) {
    // Ход диалога это ронять не должно: клиент уже получил ответ бота.
    void logSystemError("ai", `Запрос звонка не записан: ${describeError(err)}`);
  }
}

/**
 * Номер клиента появился ПОЗЖЕ просьбы о звонке — обычный порядок в переписке:
 * «соедините» → «хорошо, ваш номер?» → номер → заявка. В этот момент запрос
 * дозаполняется карточкой и соединение пробуется снова.
 */
export async function tryConnectPendingCallback(conversationId: string, clientId?: string | null): Promise<void> {
  try {
    const pending = await prisma.callbackRequest.findFirst({
      where: { conversationId, doneAt: null, customerActionId: null },
      orderBy: { requestedAt: "desc" },
      select: { id: true, clientId: true, phone: true, channel: true, byClientRequest: true },
    });
    if (!pending) return;
    if (clientId && !pending.clientId) {
      await prisma.callbackRequest.update({ where: { id: pending.id }, data: { clientId } });
    }
    // Номер мог появиться в переписке уже после просьбы — это и есть обычный
    // порядок («соедините» → «ваш номер?» → номер).
    if (!pending.phone) {
      const phone = await volunteeredPhoneFromConversation(conversationId);
      if (phone) await prisma.callbackRequest.update({ where: { id: pending.id }, data: { phone } });
    }
    // Номер дозаполняем всегда (агенту он нужен в любом случае), а НАБИРАЕМ
    // дежурного по тем же двум условиям: просьба самого клиента и канал АТС.
    if (pending.byClientRequest && isOperatorCallbackChannel(pending.channel)) {
      void connectCallbackToOperator(pending.id);
    }
  } catch (err) {
    void logSystemError("ai", `Обратный звонок: дозаполнение не удалось: ${describeError(err)}`);
  }
}

// cancelClientCallbackRequests переехала в callbackRequestsCancel.ts (07.09.2026,
// разрыв цикла импортов — см. заголовок того файла). Реэкспорт ниже сохраняет
// прежний путь для routes/clients/card.ts.
export { cancelClientCallbackRequests } from "./callbackRequestsCancel.js";

/**
 * Незакрытые запросы — то, по чему клиенты ждут живого звонка прямо сейчас.
 *
 * `canSeePhone` — право `clients.viewPhone` смотрящего (22.09.2026). До этого
 * список отдавал `r.phone ?? client.phone` и имя карточки СЫРЫМИ, а экран висит
 * на праве `messages.view`, которое есть у менеджера, — то есть правило
 * lib/clientPhone.ts обходилось плашкой «Клиент просит звонок». Аргумент
 * обязателен намеренно: умолчание «показывать» однажды уже стоило этому
 * проекту утечки, и следующий вызывающий обязан сказать, кому он отдаёт.
 */
export async function loadPendingCallbackRequests(
  canSeePhone: boolean,
  limit = 20,
  options: { includeLegacy?: boolean; staffAgentId?: string; conversationId?: string } = {}
): Promise<CallbackRequestView[]> {
  const take = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 100) : 20;
  let rows: CallbackRequest[];
  let phoneVisible = canSeePhone;
  if (options.staffAgentId) {
    const agent = await prisma.agent.findUnique({ where: { id: options.staffAgentId }, select: { isActive: true, role: true, permissions: true } });
    if (!agent?.isActive || isReadOnlyRole(agent.role as Role)) return [];
    const permissions = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
    phoneVisible = canSeePhone && permissions.has("clients.viewPhone");
    if (permissions.has("messages.view")) {
      rows = await prisma.callbackRequest.findMany({
        // Recorded managed tasks stay visible after rollback/new-request OFF.
        where: { doneAt: null, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          ...(options.includeLegacy === false ? { customerActionId: { not: null } } : {}) },
        orderBy: { requestedAt: "asc" }, take,
      });
    } else if (permissions.has("messages.viewOwn")) {
      // ACL/saved binding is checked BEFORE LIMIT, never by filtering a global
      // first page. A queued assignee is not permission to see this conversation.
      rows = await prisma.$queryRaw<CallbackRequest[]>`SELECT r.* FROM "CallbackRequest" r
        JOIN "CustomerAction" a ON a."id"=r."customerActionId" AND a."resourceId"=r."id"
        JOIN "CustomerInquiry" i ON i."id"=a."inquiryId" AND i."conversationId"=r."conversationId"
        JOIN "BotConversation" c ON c."id"=i."conversationId" AND c."endpointScopeId"=i."endpointScopeId"
        JOIN "CustomerEndpointScope" s ON s."id"=i."endpointScopeId" AND s."kind"='NORMAL'
          AND c."channel"=s."channel" AND c."accountId" IS NOT DISTINCT FROM s."messengerAccountId"
        LEFT JOIN "Client" cl ON cl."id"=c."clientId"
        WHERE r."doneAt" IS NULL AND a."status"='COMMITTED' AND a."supersededAt" IS NULL
          AND (${options.conversationId ?? null}::text IS NULL OR r."conversationId"=${options.conversationId ?? null})
          AND r."lifecycleStatus" IN ('QUEUED','ACCEPTED')
          AND r."handoverFence"->'fence'->>'nativeId'=c."id"
          AND r."handoverFence"->'fence'->'endpoint'->>'endpointScopeId'=s."id"
          AND r."handoverFence"->'fence'->'endpoint'->>'channel'=c."channel"
          AND r."handoverFence"->'fence'->'endpoint'->>'peerId'=c."subscriberId"
          AND (r."handoverFence"->'fence'->'endpoint'->>'accountId') IS NOT DISTINCT FROM c."accountId"
          AND r."handoverFence"->'fence'->>'bindingRevision'=i."bindingRevision"::text
          AND r."handoverFence"->'fence'->>'scopeRevision'=s."scopeRevision"::text
          AND ${ownBotConversationSql(options.staffAgentId)}
        ORDER BY r."requestedAt" ASC LIMIT ${take}`;
    } else return [];
  } else {
    // Backwards-compatible internal legacy projection has no current staff
    // context and therefore cannot expose managed resources.
    if (options.includeLegacy === false) return [];
    rows = await prisma.callbackRequest.findMany({ where: { doneAt: null, customerActionId: null,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}) },
      orderBy: { requestedAt: "asc" }, take });
  }
  if (rows.length === 0) return [];

  // Имена одним запросом на список — не по строке (N+1). deletedAt: null — та же
  // страховка, что у loadPendingCallbackRequests самой (27.08.2026): гашение при
  // удалении покрывает основной путь, а этот фильтр — записи, накопившиеся до
  // правки, и редкую гонку между удалением и опросом баннера.
  const clientIds = rows.map((r) => r.clientId).filter((id): id is string => !!id);
  const clients = clientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: clientIds }, deletedAt: null },
        select: { id: true, shortId: true, fullName: true, phone: true },
      })
    : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // Запрос ссылался на клиента, а его среди живых не нашлось (удалён, пока
  // просьба ждала) — закрываем тут же, а не оставляем всплывать на каждом опросе.
  const orphanIds = rows.filter((r) => !r.customerActionId && r.clientId && !clientById.has(r.clientId)).map((r) => r.id);
  if (orphanIds.length > 0) {
    await prisma.callbackRequest.updateMany({ where: { id: { in: orphanIds }, customerActionId: null }, data: { doneAt: new Date() } });
  }
  const orphanSet = new Set(orphanIds);

  return rows
    .filter((r) => !orphanSet.has(r.id))
    .map((r) => {
    const client = r.clientId ? clientById.get(r.clientId) : undefined;
    return {
      id: r.id,
      requestKind: r.requestKind ?? null,
      lifecycleStatus: r.lifecycleStatus ?? null,
      lifecycleRevision: r.lifecycleRevision?.toString() ?? null,
      assignedAgentId: r.assignedAgentId ?? null,
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      closureReason: r.closureReason ?? null,
      topic: phoneSafeText(r.topic, phoneVisible),
      channel: r.channel,
      // Телефон из записи, а если бот его не знал — из карточки клиента: она могла
      // пополниться позже, и агенту нужен номер, а не история его появления.
      phone: ((phone) => (phone === null ? null : clientPhoneFor(phone, phoneVisible)))(r.phone ?? client?.phone ?? null),
      requestedAt: r.requestedAt.toISOString(),
      conversationId: r.conversationId,
      clientId: r.clientId,
      clientShortId: client?.shortId ?? null,
      clientName: client?.fullName ? clientNamePhoneSafe(client.fullName, phoneVisible) : null,
    };
  });
}

/**
 * САМОЗАКРЫТИЕ ПРОСЬБ О ЗВОНКЕ (18.08.2026).
 *
 * До сих пор запрос гасили ровно два события: кнопка «Позвонил» и успешное
 * авто-соединение. На проде авто-соединение не срабатывает (АТС чинят отдельно), а
 * агенты звонят клиентам как обычно — из карточки или с мобильного, — и плашка
 * «Клиент просит звонок» продолжала висеть над уже состоявшимся разговором. Плашка,
 * которая врёт, перестаёт что-либо значить: её начинают закрывать не глядя.
 *
 * Закрываем два случая, оба — по факту, а не по догадке:
 *  1. Звонок клиенту СОСТОЯЛСЯ после просьбы (Interaction type="CALL" позже
 *     requestedAt). Просить о том, что уже сделано, незачем; автором закрытия
 *     становится тот, кто звонил.
 *  2. Просьба протухла — старше AUTO_CONNECT_MAX_AGE_MS. Такие запросы автопрозвон
 *     уже не берёт (см. autoConnectDueCallback), то есть висят они впустую. Не
 *     удаляем, а закрываем: doneById остаётся null — закрыл не человек, и путать
 *     машинное закрытие с работой агента нельзя.
 *
 * Идемпотентно: всё закрытие идёт updateMany с условием doneAt: null, повторный тик
 * крона не перепишет ни автора, ни время.
 */
export async function closeSettledCallbackRequests(now = new Date()): Promise<{ byCall: number; expired: number }> {
  // Предел выборки: за один тик разбираем не больше сотни просьб. Хвост, если он
  // когда-нибудь появится, разберёт следующий тик через десять минут.
  const open = await prisma.callbackRequest.findMany({
    // Managed lifecycle never derives completion from phone/Client CALLs.
    where: { doneAt: null, customerActionId: null },
    orderBy: { requestedAt: "asc" },
    take: 100,
    select: { id: true, clientId: true, phone: true, requestedAt: true },
  });
  if (open.length === 0) return { byCall: 0, expired: 0 };

  const staleBefore = new Date(now.getTime() - AUTO_CONNECT_MAX_AGE_MS);
  const stale = open.filter((r) => r.requestedAt < staleBefore);
  const fresh = open.filter((r) => r.requestedAt >= staleBefore);

  let expired = 0;
  if (stale.length > 0) {
    expired = (
      await prisma.callbackRequest.updateMany({
        where: { id: { in: stale.map((r) => r.id) }, doneAt: null, customerActionId: null },
        data: { doneAt: now },
      })
    ).count;

    /**
     * След в хронологии клиента — чтобы через месяц было видно, что просьбу не
     * замяли, а закрыло время. Автор — system (logTimeline, П-10), не агент:
     * закрыло время, а не держатель карточки. subjectAgentId — держатель, если
     * он есть; у клиента без агента запись всё равно нужна (раньше её вообще не
     * писали — Interaction.agentId был NOT NULL, теперь этого ограничения нет).
     */
    const staleClientIds = stale.map((r) => r.clientId).filter((id): id is string => !!id);
    if (staleClientIds.length > 0) {
      const owners = await prisma.client.findMany({
        where: { id: { in: staleClientIds } },
        select: { id: true, assignedAgentId: true },
      });
      if (owners.length > 0) {
        await logTimelineMany(
          owners.map((c) => ({
            clientId: c.id,
            actor: { kind: "system", source: "callbackRequests", subjectAgentId: c.assignedAgentId },
            type: "SYSTEM",
            notes: "Просьба о звонке закрыта автоматически: истекли двое суток",
          }))
        );
      }
    }
  }

  if (fresh.length === 0) return { byCall: 0, expired };

  /**
   * Клиент запроса: либо прямая ссылка, либо — если бот записал только номер —
   * карточка с тем же телефоном. Разрешаем номера ОДНИМ запросом на весь список:
   * findUnique по строке дал бы классический N+1.
   */
  const phones = fresh.filter((r) => !r.clientId && r.phone).map((r) => r.phone as string);
  const byPhone = new Map<string, string>();
  if (phones.length > 0) {
    const clients = await prisma.client.findMany({
      where: { phone: { in: phones } },
      select: { id: true, phone: true },
      take: 200,
    });
    for (const c of clients) if (c.phone) byPhone.set(c.phone, c.id);
  }
  const withClient = fresh
    .map((r) => ({ ...r, resolvedClientId: r.clientId ?? (r.phone ? byPhone.get(r.phone) ?? null : null) }))
    .filter((r): r is typeof r & { resolvedClientId: string } => !!r.resolvedClientId);
  if (withClient.length === 0) return { byCall: 0, expired };

  // Звонки тоже одним запросом на весь список: берём всё, что могло быть ответом на
  // самую старую из просьб, и раскладываем по клиентам уже в памяти.
  const earliest = withClient.reduce((min, r) => (r.requestedAt < min ? r.requestedAt : min), withClient[0].requestedAt);
  const calls = await prisma.interaction.findMany({
    where: {
      type: "CALL",
      clientId: { in: withClient.map((r) => r.resolvedClientId) },
      createdAt: { gt: earliest },
      // Закрыть просьбу может только звонок живого агента (actorKind=AGENT) —
      // системный/ИИ-след здесь не в счёт (П-10, 17.09.2026).
      agentId: { not: null },
      // Несостоявшийся звонок просьбу не закрывает (аудит 04.10.2026, CALL-01):
      // AGENT_NO_PICKUP (агент не снял свою трубку, клиенту не звонили) и CANCELLED
      // (отбой до ответа клиента). Простое `notIn` отбросило бы и null (ручную
      // запись и звонки до 27.08.2026), поэтому null разрешён отдельно. NO_ANSWER
      // оставлен закрывающим: клиенту звонили, это попытка (как в inactiveTrafficLight).
      OR: [{ callAttempt: null }, { callAttempt: { notIn: ["AGENT_NO_PICKUP", "CANCELLED"] } }],
    },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: { clientId: true, agentId: true, createdAt: true },
  });
  if (calls.length === 0) return { byCall: 0, expired };
  const callsByClient = new Map<string, { agentId: string; createdAt: Date }[]>();
  for (const call of calls) {
    if (!call.agentId) continue;
    const entry = { agentId: call.agentId, createdAt: call.createdAt };
    const list = callsByClient.get(call.clientId);
    if (list) list.push(entry);
    else callsByClient.set(call.clientId, [entry]);
  }

  // Группируем по автору звонка: одно updateMany на агента вместо запроса на просьбу.
  const idsByAgent = new Map<string, string[]>();
  for (const request of withClient) {
    // Строго ПОЗЖЕ просьбы: звонок, бывший до неё, как раз и есть повод для просьбы
    // («не дозвонились — перезвоните»), и закрывать ею просьбу было бы наоборот.
    const call = callsByClient.get(request.resolvedClientId)?.find((c) => c.createdAt > request.requestedAt);
    if (!call) continue;
    const ids = idsByAgent.get(call.agentId);
    if (ids) ids.push(request.id);
    else idsByAgent.set(call.agentId, [request.id]);
  }
  if (idsByAgent.size === 0) return { byCall: 0, expired };

  const results = await Promise.all(
    [...idsByAgent].map(([agentId, ids]) =>
      prisma.callbackRequest.updateMany({
        where: { id: { in: ids }, doneAt: null, customerActionId: null },
        data: { doneAt: now, doneById: agentId },
      })
    )
  );
  return { byCall: results.reduce((sum, r) => sum + r.count, 0), expired };
}

/** Агент позвонил (или запрос неактуален) — закрываем с автором действия. */
export async function markCallbackDone(id: string, agentId: string): Promise<boolean> {
  const result = await prisma.callbackRequest.updateMany({
    // Условие doneAt: null делает закрытие идемпотентным: двойной клик или два
    // агента разом не перезапишут, кто закрыл на самом деле.
    // Managed callers must use exact staff actor + lifecycleRevision CAS.
    where: { id, doneAt: null, customerActionId: null },
    data: { doneAt: new Date(), doneById: agentId },
  });
  return result.count > 0;
}
