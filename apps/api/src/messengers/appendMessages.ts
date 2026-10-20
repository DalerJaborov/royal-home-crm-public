import { prisma, type TxClient } from "../db.js";
import { isActiveTransactionClient } from "../lib/transactionScope.js";
import type { ChatMessage } from "../ai/client.js";
import { publishMessageNew } from "../lib/livePublish.js";
import { scheduleSellerFactsRefreshForConversation } from "../lib/sellerFacts.js";
import { traceWebsiteMessagesPersisted } from "../lib/botTurnTrace.js";

/**
 * Атомарная запись истории диалога — отдельный модуль без зависимостей от лидов
 * и доставки. Раньше жил в messengers/conversation.ts, и lib/conversationDelivery.ts
 * тянул через него leads.ts → services/leads/intake.ts → lib/absentAgentNotice.ts →
 * снова conversationDelivery: цикл импортов (правило no-circular в CI, 10.09.2026).
 */

/**
 * Направление пачки для живого события: есть ли в ней реплика клиента.
 *
 * Пачка почти всегда однородна (входящее ИЛИ ответ), а когда нет — «входящее»
 * важнее: по нему на фронте зажигается непрочитанное.
 */
function batchDirection(messages: ChatMessage[]): "IN" | "OUT" {
  return messages.some((m) => m.role === "user") ? "IN" : "OUT";
}

/** Ограничиваем хранимую ленту: приём заявки — короткий диалог. Модель и так видит только последние ходы. */
export const MAX_STORED_MESSAGES = 40;

/**
 * Атомарно дописывает новые сообщения в конец истории диалога (jsonb «||» на стороне
 * БД) и обрезает хвост до MAX_STORED_MESSAGES. Обычный read-modify-write здесь опасен:
 * пока ход ждёт ИИ и typing-delay (секунды), параллельный вебхук может записать в ту же
 * колонку исходящее сообщение сотрудника — запись устаревшего снимка затёрла бы его.
 * Поэтому пишем ТОЛЬКО новые реплики, а конкатенацию делает Postgres.
 */
export async function appendConversationMessages(conversationId: string, newMessages: ChatMessage[]): Promise<void> {
  if (newMessages.length === 0) return;
  const { affectedRows, messages } = await appendConversationRows(prisma, conversationId, newMessages);
  traceWebsiteMessagesPersisted(conversationId, messages, affectedRows);
  void publishMessageNew("bot", conversationId, batchDirection(messages));
  if (batchDirection(messages) === "IN") scheduleSellerFactsRefreshForConversation("bot", conversationId);
}

/** Narrow customer-adapter seam. Caller owns native/scope fences and publishes
 * notifications after commit. No seller/Profile refresh or network runs here. */
export async function appendConversationMessagesInTransaction(db: Pick<TxClient, "$executeRaw">,
  conversationId: string, messages: ChatMessage[]): Promise<{ affectedRows: number; messages: ChatMessage[] }> {
  if (!isActiveTransactionClient(db)) throw new Error("Active message transaction required");
  return appendConversationRows(db, conversationId, messages);
}

async function appendConversationRows(db: Pick<TxClient, "$executeRaw">, conversationId: string,
  newMessages: ChatMessage[]): Promise<{ affectedRows: number; messages: ChatMessage[] }> {
  if (!newMessages.length) return { affectedRows: 0, messages: [] };
  // Время реплики проставляется ЗДЕСЬ, в единственном месте записи истории: иначе
  // его пришлось бы не забыть в десятке мест, где реплики собираются. Без него
  // модель не отличает разговор трёхмесячной давности от начатого минуту назад —
  // см. ai/conversationTime.ts.
  const stampedAt = new Date().toISOString();
  newMessages = newMessages.map((m) => (m.at ? m : { ...m, at: stampedAt }));
  const affectedRows = await db.$executeRaw`
    UPDATE "BotConversation"
    SET "messages" = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM (
        SELECT elem, ord
        FROM jsonb_array_elements("messages" || ${JSON.stringify(newMessages)}::jsonb) WITH ORDINALITY AS t(elem, ord)
        ORDER BY ord DESC
        LIMIT ${MAX_STORED_MESSAGES}
      ) AS tail
    ),
    "updatedAt" = now()
    WHERE "id" = ${conversationId}`;
  return { affectedRows, messages: newMessages };
}


/**
 * То же самое для собственного Telegram-бота (отдельная таблица). У неё до сих пор
 * не было ни атомарного append, ни ограничения длины: история росла без предела и
 * целиком читалась в память на каждом сообщении и в каждом запросе списка инбокса.
 */
export async function appendTelegramConversationMessages(
  conversationId: string,
  newMessages: ChatMessage[]
): Promise<void> {
  if (newMessages.length === 0) return;
  const stampedAt = new Date().toISOString();
  newMessages = newMessages.map((m) => (m.at ? m : { ...m, at: stampedAt }));
  await prisma.$executeRaw`
    UPDATE "TelegramConversation"
    SET "messages" = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM (
        SELECT elem, ord
        FROM jsonb_array_elements("messages" || ${JSON.stringify(newMessages)}::jsonb) WITH ORDINALITY AS t(elem, ord)
        ORDER BY ord DESC
        LIMIT ${MAX_STORED_MESSAGES}
      ) AS tail
    ),
    "updatedAt" = now()
    WHERE "id" = ${conversationId}`;
  void publishMessageNew("telegram", conversationId, batchDirection(newMessages));
  if (batchDirection(newMessages) === "IN") scheduleSellerFactsRefreshForConversation("telegram", conversationId);
}


/**
 * ОТПРАВКА В TELEGRAM УПАЛА — ПОМЕТИТЬ ОТВЕТ КАК НЕ ДОШЕДШИЙ (правка 22.09.2026).
 *
 * Зеркало `markLastReplyUndelivered` из messengers/conversation.ts, заведённого
 * 20.09 ровно под этот класс для каналов Meta. В Telegram его не было вовсе, хотя
 * дыра та же и шире: реплика бота пишется в переписку ДО отправки, а Bot API
 * бросает на любой отказ — человек заблокировал бота, 403, 429, таймаут. Telegram
 * при этом уже получил от нас 200, повтора не будет. Сотрудник открывает инбокс,
 * видит «бот ответил» и сам не отвечает: человек остаётся без ответа вообще.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ РЯДОМ С ОРИГИНАЛОМ. `conversation.ts` тянет за собой лиды и
 * доставку; `telegram/bot.ts` и `messengers/telegramDirectMessages.ts` уже
 * импортируют этот модуль ради записи истории. Отметка — часть той же записи.
 *
 * ПОЧЕМУ УСЛОВИЕ `deliveryStatus IS NULL`: пометка ставится один раз и не
 * перекрывает уже проставленную. Пузырей в реплике может быть несколько, а
 * элемент переписки один — поэтому зовущая сторона метит ТОЛЬКО когда не ушёл ни
 * один пузырь (тот же довод, что у оригинала: «первый дошёл, второй нет» честно
 * пометить нечем).
 */
export async function markLastTelegramReplyUndelivered(
  kind: "telegram" | "telegram-direct",
  conversationId: string
): Promise<void> {
  try {
    // Имя таблицы нельзя параметризовать — отсюда две ветки вместо одной.
    if (kind === "telegram") {
      await prisma.$executeRaw`
        UPDATE "TelegramConversation"
        SET "messages" = jsonb_set(
          "messages",
          ARRAY[(jsonb_array_length("messages") - 1)::text, 'deliveryStatus'],
          to_jsonb('failed'::text)
        )
        WHERE "id" = ${conversationId}
          AND jsonb_typeof("messages") = 'array'
          AND jsonb_array_length("messages") > 0
          AND "messages"->-1->>'role' = 'assistant'
          AND "messages"->-1->>'deliveryStatus' IS NULL`;
    } else {
      await prisma.$executeRaw`
        UPDATE "TelegramDirectConversation"
        SET "messages" = jsonb_set(
          "messages",
          ARRAY[(jsonb_array_length("messages") - 1)::text, 'deliveryStatus'],
          to_jsonb('failed'::text)
        )
        WHERE "id" = ${conversationId}
          AND jsonb_typeof("messages") = 'array'
          AND jsonb_array_length("messages") > 0
          AND "messages"->-1->>'role' = 'assistant'
          AND "messages"->-1->>'deliveryStatus' IS NULL`;
    }
  } catch (err) {
    // Отметка — это честность инбокса, а не условие разговора: уронить ход из-за
    // неё нельзя.
    console.error("[бот] неудачная отправка в Telegram не отмечена:", err);
  }
}
