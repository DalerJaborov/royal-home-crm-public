import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import type { ChatMessage } from "../ai/shared.js";
import { customerPropertyTurnTerminal } from "./customerPropertyHistory.js";
import { currentTurnHasCustomerOutbox } from "./customerOutbox.js";
import { withLegacyMetaDmSource } from "./customerLegacyPhysicalSource.js";
import { legacyMetaDmSourceAlreadyAttempted } from "./customerLegacyPhysical.js";
import { loadCustomerTransportForConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { sendManagedCustomerPropertyReply } from "./customerPropertyDelivery.js";
import { withBotTurnTrace, traceOutcome, traceNoReply, traceBindAccount, traceDeferUntil } from "./botTurnTrace.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { markLastReplyUndelivered, stampOutgoingMid } from "../messengers/conversationStore.js";
import { processMessengerTurn } from "../messengers/conversation.js";
import { asMetaChannel, sendMessage as sendMetaMessage } from "../messengers/meta.js";
import { WEBSITE_CHANNEL } from "../messengers/channels.js";
import { isOutboundBlockedError } from "./outboundShield.js";
import { accountTokenById, listAccounts } from "../messengers/accounts.js";
import { deliverBotVoiceReply } from "./conversationDelivery.js";
import { sleep } from "../messengers/humanPacing.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * ЗАВИСШИЕ ДИАЛОГИ — общая логика для ручной кнопки (routes/errorLog.ts) и
 * автоматического периодического прогона (cron.ts). Раньше жила только в
 * маршруте, поэтому «само починилось» работало исключительно если кто-то
 * заходил в Настройки и нажимал кнопку — вынесено сюда одним модулем, чтобы
 * не разъезжаться в двух копиях.
 */
export const STUCK_LIMIT = 200;

export interface StuckRow {
  id: string;
  channel: string;
  subscriberId: string;
  name: string | null;
  accountId: string | null;
  lastText: string;
  lastMessageAt: Date;
  /** Captured with lastText/lastMessageAt, never adopted from a later read. */
  lastMid?: string | null;
}

/**
 * Предел выборки обязателен: без него один тяжёлый день мог бы вернуть тысячи строк.
 *
 * ИСКЛЮЧЕНИЕ КЛИЕНТОВ С ЖИВЫМ АГЕНТОМ (14.09.2026, скриншоты владельца — тестовый
 * агент Далер). Диалог, у чьего клиента сейчас есть активный `assignedAgentId`
 * (не LOST/ARCHIVED/INACTIVE), бот молчит НАМЕРЕННО — conversationState.ts
 * hasActiveAssignedAgent, решение владельца 05.09.2026 «бот не должен отвечать,
 * если клиент у агента». Это НЕ «застрял», это «ждёт человека», но старая
 * выборка не отличала одно от другого: последняя реплика клиента без ответа —
 * ровно то же самое, что и настоящий сбой ИИ. Крон health-automation (каждые
 * 30 минут) ставил на такой диалог `ai-reply-retry» заново на каждом тике,
 * задание успешно завершалось (`retryStuckConversation` → "no-reply", бот и
 * должен был промолчать), а retryStuckConversation → processMessengerTurn
 * попутно шлёт `notifyAgentOfClientMessage` (тот же пуш с текстом сообщения
 * клиента) БЕЗ проверки на паузу — и агент получал одно и то же уведомление
 * каждые полчаса бесконечно, пока не примет/отклонит лид сам. Живой пример:
 * реактивационный лид «Сафия», переданный агенту в 18:32, пушил его же
 * сообщением клиента ещё шесть раз подряд за три часа.
 */
export async function findStuckConversations(): Promise<StuckRow[]> {
  return prisma.$queryRaw<StuckRow[]>`
    SELECT bc.id, bc.channel, bc."subscriberId", bc.name, bc."accountId", bc."lastMessageAt",
           COALESCE(pending.elem ->> 'content', '') AS "lastText", pending.elem ->> 'mid' AS "lastMid"
    FROM "BotConversation" bc
    JOIN LATERAL (
      SELECT m.elem FROM jsonb_array_elements(CASE WHEN jsonb_typeof(bc.messages)='array' THEN bc.messages ELSE '[]'::jsonb END)
        WITH ORDINALITY AS m(elem, ord)
      WHERE m.elem ->> 'role'='user' ORDER BY m.ord DESC LIMIT 1
    ) pending ON true
    LEFT JOIN "Client" c ON c.id = bc."clientId"
    ${stuckWhere()}
    ORDER BY bc."lastMessageAt" ASC
    LIMIT ${STUCK_LIMIT}
  `;
}

export interface StuckChannelCount {
  channel: string;
  count: number;
  oldestAt: Date;
}

/**
 * Те же «зависшие», но только ЧИСЛО по каналам, без предела (02.10.2026, класс
 * «Пагинация»). Плитка «Сейчас ждут ответа» на «Источниках» раньше считала
 * длину выборки findStuckConversations — а та режется на STUCK_LIMIT=200, и в
 * тяжёлый день экран показывал «200», когда ждали сотни сверху. COUNT по тому
 * же условию (stuckWhere — одно место на обе выборки) не тащит ни одной строки.
 */
export async function countStuckConversationsByChannel(): Promise<StuckChannelCount[]> {
  return prisma.$queryRaw<StuckChannelCount[]>`
    SELECT bc.channel, COUNT(*)::int AS count, MIN(bc."lastMessageAt") AS "oldestAt"
    FROM "BotConversation" bc
    LEFT JOIN "Client" c ON c.id = bc."clientId"
    ${stuckWhere()}
    GROUP BY bc.channel
  `;
}

/** Условие «завис» — одно на выборку для повтора и на подсчёт для экрана, чтобы
 *  число на «Источниках» и то, что чинит крон, не разъехались. */
function stuckWhere(): Prisma.Sql {
  return Prisma.sql`
    -- Минус 10 минут от начала суток: иначе в первые пять минут после полуночи по
    -- Душанбе реплика не может быть одновременно «сегодняшней» и старше пяти минут
    -- (см. условие про живой ход ниже), и зависший на стыке суток терялся бы.
    WHERE bc."lastMessageAt" >= ${new Date(dushanbeStartOfToday().getTime() - 10 * 60 * 1000)}
      AND jsonb_typeof(bc.messages) = 'array'
      AND jsonb_array_length(bc.messages) > 0
      AND bc.messages->-1->'customerPropertyDelivery' IS NULL
      AND (
        (
          (bc.messages -> (jsonb_array_length(bc.messages) - 1) ->> 'role') = 'user'
          -- Реплику клиента записал не вебхук, а сам код (тихий приём номера, когда бот
          -- намеренно молчит) — отвечать на неё нельзя: молчание здесь решение, а не
          -- сбой. Авария 17.09.2026: сторож лидов дописывал такую реплику каждые 15
          -- минут, повтор «зависших» принимал её за неотвеченное сообщение и бот слал
          -- клиенту «Ташаккур, рақаматонро қабул кардам…» каждые полчаса, по всем чатам.
          AND COALESCE(bc.messages -> (jsonb_array_length(bc.messages) - 1) ->> 'silentCapture', 'false') <> 'true'
          -- ЖИВОЙ ХОД ЕЩЁ ИДЁТ — ЭТО НЕ «ЗАВИС» (28.09.2026, жалоба владельца: три
          -- реплики бота подряд на одно «Ман сохибхона»). Реплика клиента пишется в
          -- историю ДО вызова модели, а ответ бота — после: окно склейки (до 90 с) и
          -- сам вызов (до 75 с) диалог выглядит неотвеченным. Крон попадал в это
          -- окно, повтор шёл мимо склейки, и модель отвечала второй раз на то же
          -- сообщение. Пять минут — с запасом на склейку и вызов модели.
          AND bc."lastMessageAt" < now() - interval '5 minutes'
        )
        OR (
          -- ОТВЕТ, КОТОРЫЙ НЕ ДОШЁЛ, ТОЖЕ «ЗАВИС» (24.09.2026, ночная проверка,
          -- находка №108). Ночью #848 научил повтор ставить deliveryStatus:'failed'
          -- на реплику бота при отказе Meta (markLastReplyUndelivered) и научил
          -- jobs/aiReplyRetry.ts проигрывать такой ход заново по реплике клиента
          -- перед недоставленным хвостом — но сама выборка «зависших» диалог
          -- по-прежнему не поднимала: последняя реплика в истории — бот, а не
          -- клиент, и первое условие выше её пропускало. Дальше диалог не видел
          -- ни этот крон, ни кнопка «Повторить зависшим» — только уже поставленное
          -- задание ai-reply-retry, если оно вообще было поставлено.
          (bc.messages -> (jsonb_array_length(bc.messages) - 1) ->> 'role') = 'assistant'
          AND (bc.messages -> (jsonb_array_length(bc.messages) - 1) ->> 'deliveryStatus') = 'failed'
          -- ЗАКРЫТОЕ ОКНО 24 ЧАСОВ — ПОВТОР БЕССМЫСЛЕН (аналог isMessagingWindowClosedError
          -- из lib/messagingWindow.ts, здесь по данным диалога, а не по тексту ошибки
          -- Graph API: сам вызов сети к моменту выборки уже давно случился и не
          -- хранится). Берём время ПОСЛЕДНЕЙ реплики КЛИЕНТА в истории — это и есть
          -- вопрос, на который бот не смог ответить, — а не bc."lastMessageAt": это
          -- поле двигает и сама неудачная ПОПЫТКА бота, которая могла случиться
          -- намного позже настоящего вопроса. Реплики без 'at' (записаны до
          -- 01.08.2026) считаются протухшими намеренно — свежести доказать нечем.
          AND (
            SELECT (m.elem ->> 'at')::timestamptz
            FROM jsonb_array_elements(bc.messages) WITH ORDINALITY AS m(elem, ord)
            WHERE m.elem ->> 'role' = 'user'
            ORDER BY m.ord DESC
            LIMIT 1
          ) >= now() - interval '24 hours'
        )
      )
      AND (bc."pausedUntil" IS NULL OR bc."pausedUntil" < now())
      AND bc."optedOutAt" IS NULL
      AND NOT (
        c."assignedAgentId" IS NOT NULL
        AND c.status NOT IN ('LOST', 'ARCHIVED')
        AND c."workStatus" != 'INACTIVE'
      )
  `;
}

/**
 * Проигрывает диалог заново на уже сохранённой истории и отправляет ответ.
 *
 * `skipSaveIncoming: true` — реплика клиента УЖЕ в истории (это она и есть
 * «последнее сообщение без ответа»); без флага processMessengerTurn записал бы
 * её в BotConversation.messages второй раз (см. conversation.ts).
 */
export function retryStuckConversation(row: StuckRow, source: "ai_retry" | "manual_retry" = "manual_retry"): Promise<"sent" | "no-reply" | "failed" | "ai-down"> {
  return withBotTurnTrace({ channel: row.channel, peer: row.subscriberId, conversation: row.id, event: null, source, text: row.lastText,
    knownContacts: row.name ? [row.name] : [] }, async () => {
    const result = await retryStuckConversationImpl(row);
    if (result === "failed" || result === "ai-down") traceOutcome("failed");
    else if (result === "no-reply") traceNoReply();
    return result;
  });
}
async function retryStuckConversationImpl(row: StuckRow): Promise<"sent" | "no-reply" | "failed" | "ai-down"> {
  if (await currentTurnHasCustomerOutbox(row.id)) return "no-reply";
  const stored = await prisma.botConversation.findUnique({ where: { id: row.id }, select: {
    messages: true, lastMessageAt: true, channel: true, subscriberId: true, accountId: true,
  } });
  if (stored && customerPropertyTurnTerminal((stored.messages as unknown as ChatMessage[]) ?? [])) return "no-reply";
  const history = (stored?.messages as unknown as ChatMessage[]) ?? [];
  let last = history.length - 1;
  while (last >= 0 && history[last].role === "assistant" && history[last].deliveryStatus === "failed") last--;
  const original = history[last];
  if (!stored || stored.channel !== row.channel || stored.subscriberId !== row.subscriberId || stored.accountId !== row.accountId ||
    stored.lastMessageAt?.getTime() !== row.lastMessageAt.getTime() || original?.role !== "user" ||
    original.content !== row.lastText || (original.mid ?? null) !== (row.lastMid ?? null)) return "no-reply";
  return withLegacyMetaDmSource(row.lastMid, () => retryStuckConversationBody(row, row.lastMid ?? undefined));
}
async function retryStuckConversationBody(row: StuckRow, originalMid?: string): Promise<"sent" | "no-reply" | "failed" | "ai-down"> {
  const metaChannel = asMetaChannel(row.channel);
  /**
   * ЧАТ НА САЙТЕ ТОЖЕ ЗАВИСАЕТ (11.09.2026).
   *
   * Раньше повтор умел только каналы Meta, а `WEBSITE` уходил в ветку
   * «неизвестный канал»: посетитель сайта, чьё сообщение попало на занятый ИИ,
   * не получал ответа НИКОГДА — диалог оставался в выборке навсегда и каждый
   * ночной прогон писал в журнал одну и ту же ошибку (в утреннем отчёте
   * директора она выглядела как «×4 сбоя ИИ»).
   *
   * Отправлять в сайте нечего: реплику пишет в переписку сам
   * processMessengerTurn, а посетитель забирает её опросом — ровно так же
   * поступает общая доставка (см. messengers/sendBotMessage.ts).
   */
  const isWebsite = row.channel === WEBSITE_CHANNEL;
  if (!metaChannel && !isWebsite) {
    void logSystemError("ai", `Повтор зависшего диалога ${row.id}: неизвестный канал «${row.channel}»`);
    return "failed";
  }
  let deliveryTransport: CustomerTransportReference | undefined;
  try {
    // Аккаунт выключен тумблером: входящий путь отбирает у него токен, и отвечать им
    // повтором нельзя (CHANNEL-NEW-11). До хода ИИ, чтобы не платить за ответ, который не
    // уйдёт; завершаем как «отвечать не нужно»: включат аккаунт, и клиент напишет снова.
    if (metaChannel && row.accountId && (await accountTokenById(row.accountId, metaChannel)).disabled) return "no-reply";
    const customerTransport = await loadCustomerTransportForConversation(row.id);
    if (!customerTransport) return "no-reply";
    if (metaChannel && await legacyMetaDmSourceAlreadyAttempted(customerTransport.endpointScopeId, originalMid)) return "no-reply";
    deliveryTransport = customerTransport;
    const account =
      metaChannel && row.accountId ? (await listAccounts(metaChannel)).find((a) => a.id === row.accountId) : null;
    traceBindAccount(account?.externalId, row.id);
    const result = await processMessengerTurn({
      channel: row.channel,
      subscriberId: row.subscriberId,
      text: row.lastText,
      name: row.name ?? undefined,
      accountExternalId: customerTransport.accountExternalId,
      customerTransport,
      skipSaveIncoming: true,
      // Повтор оплаченного хода: суточный бюджет ИИ не списывается второй раз.
      retryOfPaidTurn: true,
    });
    // «Модель всё ещё лежит» и «отвечать не нужно по правилам» — разные исходы:
    // первый ретраит задание ai-reply-retry, второй завершает его как успех.
    if (result.aiUnavailable) return "ai-down";
    if (result.shouldReply === false || !result.reply) return "no-reply";

    // Чат на сайте: реплика уже в переписке, сети здесь нет — ход завершён.
    if (!metaChannel) return "sent";

    const token = (await accountTokenById(row.accountId, metaChannel)).token;
    if (result.customerPropertyReply) {
      const outcome = await sendManagedCustomerPropertyReply(result.customerPropertyReply,
        () => sendMetaMessage(metaChannel, row.subscriberId, result.reply, token, { transport: customerTransport }));
      return outcome === "accepted" ? "sent" : "no-reply";
    }
    await stampOutgoingMid(
      metaChannel,
      row.subscriberId,
      await sendMetaMessage(metaChannel, row.subscriberId, result.reply, token, { transport: customerTransport }), customerTransport
    );
    if (result.reply2) {
      await sleep(1500);
      await stampOutgoingMid(
        metaChannel,
        row.subscriberId,
        await sendMetaMessage(metaChannel, row.subscriberId, result.reply2, token, { transport: customerTransport }), customerTransport
      );
    }
    if (result.replyVoiceWav) {
      traceDeferUntil(deliverBotVoiceReply(metaChannel, row.subscriberId, result.replyVoiceWav, { clientId: null, clientName: null }, customerTransport).catch((err) =>
        console.error("[голосовой ответ] повтор зависшего:", err instanceof Error ? err.message : err)
      ));
    }
    return "sent";
  } catch (err) {
    /**
     * ЩИТ ИСХОДЯЩИХ НЕ ВЫПУСТИЛ — ЭТО НЕ СБОЙ ПОВТОРА (17.09.2026).
     *
     * «failed» заставило бы очередь пробовать снова до четырёх часов — ровно то
     * поведение, которое щит и остановил. Завершаем задание как «отвечать не
     * нужно»: причина уже записана в журнал самим щитом, диалог на паузе, и
     * первое же сообщение живого человека снимет её само.
     */
    if (isOutboundBlockedError(err)) { traceOutcome("blocked"); return "no-reply"; }
    /**
     * ОТВЕТ, КОТОРЫЙ НЕ УШЁЛ, НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ ОТПРАВЛЕННЫМ — И В ПОВТОРЕ ТОЖЕ
     * (24.09.2026, ночная проверка).
     *
     * Реплика бота дописана в историю внутри processMessengerTurn ещё ДО отправки.
     * Вебхук Meta (routes/webhooks.ts) и оба пути Telegram при отказе отправки
     * ставят отметку «не дошло»; повтор зависшего был единственным путём без неё.
     * Без отметки задание ai-reply-retry на следующей попытке видело «последняя
     * реплика — бот» и закрывалось как «уже отвечено», а findStuckConversations
     * диалог больше не поднимал: клиент без ответа, в CRM ответ выглядит
     * отправленным. Отметка ставится только на реплику без mid — если ход упал
     * раньше отправки (последняя реплика клиентская) или первый пузырь уже дошёл,
     * запрос ничего не меняет. Для чата на сайте сети нет, метить нечего.
     */
    if (metaChannel) await markLastReplyUndelivered(metaChannel, row.subscriberId, deliveryTransport ?? row.accountId);
    void logSystemError("ai", `Повтор зависшего диалога (${row.channel}, ${row.id}) не удался: ${describeError(err)}`);
    return "failed";
  }
}

/**
 * Последовательный прогон всех зависших диалогов с паузой между отправками.
 *
 * ⚠️ С 27.08.2026 БОЕВЫЕ ПУТИ ЕЮ НЕ ПОЛЬЗУЮТСЯ (аудит №4): и кнопка «Повторить
 * зависшим», и ночная автоматика здоровья ставят задания ai-reply-retry —
 * очередь дедуплицирует по диалогу и остаётся единственным исполнителем.
 * Раньше трое исполнителей могли проигрывать один диалог одновременно, и после
 * простоя ИИ клиент получал два разных ответа на одно сообщение. Функция
 * оставлена для тестов и ручной отладки; новых вызывающих не добавлять.
 */
export async function retryAllStuckConversations(rows: StuckRow[]): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const result = await retryStuckConversation(rows[i]);
    if (result === "sent") sent++;
    // «ИИ лежит» для нажавшего кнопку — тоже неуспех: ответа клиент не получил.
    // Сам диалог при этом уже стоит в очереди ai-reply-retry и догонит позже.
    else if (result === "failed" || result === "ai-down") failed++;
    if (i < rows.length - 1) await sleep(1200);
  }
  return { sent, failed };
}
