/**
 * Отправка ответа на «уточню у собственника».
 *
 * ОТДЕЛЬНЫМ МОДУЛЕМ ОТ ownerQuestions.ts — не для красоты. Запись вопроса нужна
 * диалоговому слою (messengers/conversation.ts), а отправка ответа сама тянет этот
 * слой обратно: получался цикл импортов, который поймал audit:deps. Цикл здесь не
 * придирка — порядок инициализации модулей становится неявным, и правка на одном
 * конце отзывается на другом.
 *
 * Граница проведена по направлению: сюда можно импортировать транспорт, отсюда в
 * диалоговый слой не импортирует никто.
 */

import { prisma } from "../db.js";
import {
  agentSender,
  deliverToConversation,
  findClientDeliveryTarget,
  type DeliveryTarget,
} from "./conversationDelivery.js";
import { shortAgentReply } from "../ai/shortAgentReply.js";
import type { ChatMessage } from "../ai/client.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { isClientLostOrAbandoned, isStalePause } from "./conversationState.js";
import { answerManagedOwnerQuestion, type ManagedOwnerAnswerContext } from "./customerOwnerQuestion.js";

export type AnswerResult =
  | { ok: true; delivered: boolean; deliveryStatus?: "HELD"; managedRevision?: string;
      holdReason?: "auto_return_unavailable" | "original_target_changed" }
  | { ok: false; status: number; error: string };

/**
 * Ответ живого человека уходит клиенту.
 *
 * Два пути доставки, и оба нужны. Если карточка клиента уже есть — обычная отправка
 * из карточки (deliverToConversation): она же ставит боту паузу и пишет реплику в
 * историю, то есть ведёт себя как ответ сотрудника, каким и является. Если карточки
 * нет (человек ещё не оставил номер, а вопрос уже задал) — шлём прямо в диалог по
 * его каналу: терять такого клиента из-за отсутствия карточки было бы глупо.
 *
 * Отметка «ответил» ставится ДАЖЕ при неудачной отправке, но deliveredAt остаётся
 * пустым. Это разные факты: человек свою часть сделал, а сеть подвела — и вопрос,
 * повисший в списке навсегда, заставил бы отвечать на него второй раз.
 */
export async function answerOwnerQuestion(
  questionId: string,
  answer: string,
  answeredById: string,
  managed?: ManagedOwnerAnswerContext
): Promise<AnswerResult> {
  const question = await prisma.ownerQuestion.findUnique({ where: { id: questionId } });
  if (!question) return { ok: false, status: 404, error: "Вопрос не найден" };
  if (question.customerActionId) return answerManagedOwnerQuestion(questionId, answer, answeredById, managed);
  if (question.answeredAt) return { ok: false, status: 409, error: "На этот вопрос уже ответили" };

  const text = answer.trim();
  let delivered = false;

  if (question.clientId) {
    const target = await findClientDeliveryTarget(question.clientId);
    if (target) {
      // Это ответ ЖИВОГО человека (answeredById), пересланный клиенту автоматически —
      // подпись обязана называть сотрудника, а не «систему» или бота.
      const result = await deliverToConversation(target, text, undefined, { sender: await agentSender(answeredById) });
      delivered = result.ok;
    }
  } else {
    /**
     * Карточки нет — отвечаем прямо в диалог, но ТОЙ ЖЕ общей доставкой
     * (11.09.2026). Раньше здесь стояла своя отправка через Graph API, и она
     * знала только каналы Meta: клиент из чата на сайте (а равно из Telegram),
     * задавший вопрос до появления карточки, ответа собственника не получал
     * НИКОГДА — причём молча, без единой строки в журнале. Общая доставка знает
     * все каналы, сама пишет реплику в переписку и ставит боту короткую паузу —
     * ровно как ответ сотрудника из карточки выше.
     */
    const target = await resolveBotConversationTarget(question.conversationId);
    if (target) {
      try {
        const result = await deliverToConversation(target, text, undefined, {
          sender: await agentSender(answeredById),
        });
        delivered = result.ok;
        if (!result.ok) void logSystemError("meta", `Ответ собственника не доставлен: ${result.error}`);
      } catch (err) {
        void logSystemError("meta", `Ответ собственника не доставлен: ${describeError(err)}`);
      }
    }
  }

  await prisma.ownerQuestion.update({
    where: { id: question.id },
    data: {
      answer: text.slice(0, 2000),
      answeredAt: new Date(),
      answeredById,
      deliveredAt: delivered ? new Date() : null,
    },
  });

  return { ok: true, delivered };
}

/**
 * Автоответ клиенту, если обещание «уточню у собственника» никто не закрыл вовремя.
 *
 * ПОЧЕМУ ЭТО НУЖНО. До этой функции запись просто лежала в базе бесконечно — реальный
 * клиент 05.08.2026 прождал трое суток без единого слова, пока сотрудники не заметили
 * висящий вопрос. Для клиента тишина хуже прямого «не знаю»: он уходит к другому
 * агентству, даже не дождавшись честного ответа.
 *
 * ЭТО НЕ ЗАКРЫВАЕТ ВОПРОС. answeredAt остаётся null — сотрудник всё ещё обязан
 * ответить по существу, автоответ только снимает клиента с голодного ожидания и не
 * даёт разговору выглядеть заброшенным. autoRepliedAt не даёт отправить его дважды.
 *
 * ЗДЕСЬ, А НЕ В ownerQuestions.ts — по той же причине, что и вся отправка в этом файле
 * (см. шапку): conversationDelivery.ts тянет messengers/conversation.ts, а тот
 * импортирует ownerQuestions.ts (recordOwnerQuestion) — цикл импортов, пойманный
 * audit:deps в CI. Граница модулей не для красоты.
 */
export async function notifyStaleOwnerQuestions(): Promise<number> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { ownerQuestionAutoReplyHours: true },
  });
  const hours = Math.max(1, settings?.ownerQuestionAutoReplyHours ?? 6);
  const threshold = new Date(Date.now() - hours * 3600_000);

  const stale = await prisma.ownerQuestion.findMany({
    // Managed questions have an immutable saved target and receipt lifecycle.
    // The legacy reminder must never rediscover their Client's current channel
    // or promise an automatic return before the P12 delivery gate exists.
    where: { customerActionId: null, answeredAt: null, autoRepliedAt: null, askedAt: { lte: threshold } },
    take: 50,
  });

  let sent = 0;
  for (const question of stale) {
    try {
      // Клиент мог завести карточку уже ПОСЛЕ вопроса — findClientDeliveryTarget
      // смотрит на актуальное состояние, а не на то, что было в момент вопроса.
      const target: DeliveryTarget | null = question.clientId
        ? await findClientDeliveryTarget(question.clientId)
        : await resolveBotConversationTarget(question.conversationId);
      if (!target) continue;
      /**
       * ДИАЛОГ ВЕДЁТ ЧЕЛОВЕК — АВТООТВЕТ НЕ НУЖЕН (24.09.2026, ночная проверка).
       *
       * Пауза бота стоит, когда агент забрал разговор и отвечает клиенту сам;
       * «всё ещё уточняю у собственника» от имени бота ложилось поверх живого
       * агента. Вопрос при этом НЕ закрывается (autoRepliedAt не ставится): пока
       * пауза держится, отвечает агент, а кончится — автоответ уйдёт как обычно.
       * Проверка стоит ДО вызова модели — на такой вопрос ход ИИ не тратится.
       * Именно здесь, а не в deliverToConversation: остальные служебные тексты
       * (подтверждение показа, вопрос об отзыве, реактивация) нужны и при паузе.
       */
      if (await isTargetPausedForBot(target)) continue;

      const history = await loadTargetHistory(target);
      const text = await shortAgentReply(
        history,
        "Клиент задал вопрос, на который бот честно ответил «уточню у собственника и вернусь», " +
          "но ответа от собственника пока нет. Напиши ОДНО короткое дружелюбное сообщение на языке " +
          "клиента: подтверди, что вопрос не забыт, ты всё ещё уточняешь, и скоро вернёшься с ответом. " +
          "НЕ придумывай ответ на сам вопрос — ты его не знаешь. Не извиняйся чрезмерно, не создавай " +
          "впечатление, что что-то пошло не так — обычное «ещё уточняю» без драмы."
      );
      if (!text) continue;

      // Текст сгенерирован моделью (shortAgentReply) без участия человека — это
      // автоответ, а не ответ конкретного сотрудника.
      const result = await deliverToConversation(target, text, undefined, { sender: { kind: "bot" } });
      if (!result.ok) continue;

      await prisma.ownerQuestion.update({ where: { id: question.id }, data: { autoRepliedAt: new Date() } });
      sent++;
    } catch (err) {
      void logSystemError("ai", `Автоответ на просроченный вопрос собственнику не отправлен: ${describeError(err)}`);
    }
  }
  return sent;
}

/**
 * ВОПРОС ИЗ ЛИЧКИ TELEGRAM-БОТА (03.10.2026, аудит audit-1, находка 3). Бот в
 * Telegram обещал «уточню у собственника», а запись не заводилась вовсе — ответу
 * некуда было вернуться. Теперь telegram/bot.ts пишет вопрос с id диалога
 * TelegramConversation, и без карточки ответ находит личку здесь. Direct Messages
 * канала сюда не входят: общая доставка (DeliveryTarget) их не знает.
 */
async function resolveTelegramConversationTarget(conversationId: string): Promise<DeliveryTarget | null> {
  const conversation = await prisma.telegramConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, chatId: true, clientId: true, client: { select: { deletedAt: true } } },
  });
  if (!conversation || (conversation.clientId && conversation.client?.deletedAt)) return null;
  return { kind: "telegram", id: conversation.id, subscriberId: conversation.chatId };
}

async function resolveBotConversationTarget(conversationId: string): Promise<DeliveryTarget | null> {
  const conversation = await prisma.botConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, channel: true, subscriberId: true, accountId: true, clientId: true, client: { select: { deletedAt: true } } },
  });
  /**
   * OwnerQuestion.clientId был null НА МОМЕНТ вопроса (карточки ещё не было), но
   * диалог мог обзавестись карточкой позже — а та могла уйти в Корзину до того, как
   * подошёл срок автоответа (разведка 07.09.2026, класс «осиротевшие спутники»).
   * findClientDeliveryTarget выше уже проверяет deletedAt для случая с известным
   * clientId — здесь та же проверка нужна для случая БЕЗ него, иначе крон продолжал
   * бы писать в диалог удалённого клиента напрямую, в обход этого фильтра.
   */
  if (!conversation) return resolveTelegramConversationTarget(conversationId);
  if (conversation.clientId && conversation.client?.deletedAt) return null;
  return {
    kind: "bot",
    id: conversation.id,
    channel: conversation.channel,
    subscriberId: conversation.subscriberId,
    accountId: conversation.accountId,
  };
}

/**
 * Бот на этом диалоге молчит (агент ведёт разговор) — то же правило, по которому
 * решает сам ход бота: Meta — `isPaused` в messengers/conversation.ts (протухшая
 * пауза у потерянного/брошенного клиента не считается), Telegram — `pausedUntil`
 * в telegram/bot.ts.
 */
async function isTargetPausedForBot(target: DeliveryTarget): Promise<boolean> {
  if (target.kind === "telegram") {
    const row = await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } });
    return !!row?.pausedUntil && row.pausedUntil.getTime() > Date.now();
  }
  const row = await prisma.botConversation.findUnique({
    where: { id: target.id },
    select: { pausedUntil: true, clientId: true },
  });
  if (!row?.pausedUntil || row.pausedUntil.getTime() <= Date.now()) return false;
  return !(row.clientId && isStalePause(row.pausedUntil) && (await isClientLostOrAbandoned(row.clientId)));
}

/** История диалога для языка/контекста — та же пара таблиц, что использует
 *  вся остальная доставка выше в этом файле. */
async function loadTargetHistory(target: DeliveryTarget): Promise<ChatMessage[]> {
  const row =
    target.kind === "telegram"
      ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { messages: true } })
      : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { messages: true } });
  return (Array.isArray(row?.messages) ? row.messages : []) as unknown as ChatMessage[];
}
