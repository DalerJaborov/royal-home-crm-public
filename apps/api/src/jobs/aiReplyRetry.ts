import { z } from "zod";
import { prisma } from "../db.js";
import { customerPropertyTurnTerminal } from "../lib/customerPropertyHistory.js";
import { currentTurnHasCustomerOutbox } from "../lib/customerOutbox.js";
import { logSystemError } from "../lib/systemError.js";
import { retryStuckConversation } from "../lib/stuckConversations.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { sendPushToAgents } from "../push.js";
import { OPERATOR_REPLY_PAUSE_MS } from "../lib/conversationDelivery.js";
import type { ChatMessage } from "../ai/client.js";
import type { JobHandler } from "./registry.js";
import { aiReplyRetryBackoffMs, BOT_TURN_JOB_TIMEOUT_MS } from "./aiReplyRetryPolicy.js";
import { enqueueBackgroundJob } from "./enqueue.js";

/** Эскалация через 2 и 24 часа, если агент так и не вернул бота — см. aiTurnBlockedFollowup.ts. */
const FOLLOWUP_24H_MS = 24 * 60 * 60 * 1000;
const FOLLOWUP_MAX_ATTEMPTS = 3;

/**
 * Со скольких сдач подряд ход считается НЕПРОХОДИМЫМ, а не «модель полежала».
 *
 * Одна сдача — это уже весь ~13-часовой веер повторов (см. aiReplyRetryPolicy.ts),
 * и её честно списывать на аварию поставщика: так было 30.08, когда основная
 * модель сутки отдавала 503. Но ДВЕ сдачи подряд по одному и тому же диалогу —
 * это больше суток одинаковых отказов на одном и том же ходе, пока соседние
 * диалоги отвечаются нормально. Такое не лечится ожиданием: значит, дело не в
 * поставщике, а в самом ходе.
 */
const PERMANENT_AFTER_GIVE_UPS = 2;

/**
 * Считаются только СВЕЖИЕ сдачи (аудит Codex 04.10, JOB-05). Строки GIVEN_UP нигде
 * не чистятся, и без границы по времени авария месячной давности плюс новая первая
 * сдача давали «две подряд» и ложно снимали бота с диалога. Между двумя сдачами
 * одной петли проходит ~13 часов веера повторов плюс до 30 минут до нового задания
 * от крона, так что 48 часов с запасом накрывают настоящую петлю.
 */
const GIVE_UPS_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * ОТЛОЖЕННЫЙ ОТВЕТ КЛИЕНТУ, ПЕРЕЖИВАЮЩИЙ ДЕПЛОЙ (чертёж Б2, 27.08.2026).
 *
 * Ставится из messengers/conversation.ts, когда ИИ не ответил ни разу. Прежний
 * механизм (ai/aiRetryQueue.ts, setTimeout до ~13 часов) держал в замыкании
 * СНИМОК диалога и умирал с процессом: несколько деплоев в день × 13-часовое
 * окно = каждый выкат гарантированно убивал чьи-то ждущие ответы.
 *
 * Здесь снимка нет вовсе: повтор проигрывает ход ЗАНОВО по свежей истории тем
 * же кодом, что и кнопка «Повторить зависшим» (lib/stuckConversations.ts) —
 * класс багов «ответ из прошлого» исчезает, потому что прошлого не хранится.
 *
 * Идемпотентность: перед отправкой проверяется, что ПОСЛЕДНЯЯ реплика в
 * истории — клиентская. Ответил кто угодно (бот более свежим ходом, агент
 * руками, сам этот джоб в прошлой попытке, упавшей между отправкой и DONE) —
 * повторять нечего, задание тихо завершается.
 */
const schema = z.object({ conversationId: z.string() });

export const aiReplyRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: "ai-reply-retry",
  schema,
  backoff: aiReplyRetryBackoffMs,
  // Ход бота: окно модели до 75 с плюс подготовка — минуты общего срока мало.
  timeoutMs: BOT_TURN_JOB_TIMEOUT_MS,
  async run(payload) {
    const conversation = await prisma.botConversation.findUnique({
      where: { id: payload.conversationId },
      select: {
        id: true,
        channel: true,
        subscriberId: true,
        name: true,
        accountId: true,
        clientId: true,
        messages: true,
        lastMessageAt: true,
        pausedUntil: true,
        optedOutAt: true,
      },
    });
    // Диалог удалён / клиент просил не писать / оператор ведёт руками — отвечать
    // боту здесь нечего и незачем; это завершение, а не ошибка.
    if (!conversation || conversation.optedOutAt) return;
    if (await currentTurnHasCustomerOutbox(payload.conversationId)) return;
    if (conversation.pausedUntil && conversation.pausedUntil.getTime() > Date.now()) return;
    // Клиент удалён (Корзина) — тратить вызов ИИ на возврат в мёртвую переписку
    // незачем (аудит трат 13.09.2026). clientId отсутствует — диалог ещё не
    // привязан к карточке, тогда фильтровать не по чему, отвечаем как обычно.
    if (conversation.clientId) {
      const client = await prisma.client.findUnique({
        where: { id: conversation.clientId },
        select: { deletedAt: true },
      });
      if (!client || client.deletedAt) return;
    }

    const history = (conversation.messages as unknown as ChatMessage[]) ?? [];
    if (customerPropertyTurnTerminal(history)) return;
    /**
     * РЕПЛИКА БОТА С ОТМЕТКОЙ «НЕ ДОШЛО» — ЭТО НЕ ОТВЕТ (24.09.2026, ночная проверка).
     *
     * Реплика бота пишется в историю ДО отправки (messengers/conversation.ts), и
     * при отказе Meta повтор помечает её deliveryStatus:"failed"
     * (lib/stuckConversations.ts → markLastReplyUndelivered). Раньше следующая
     * попытка видела «последняя реплика — бот» и закрывала задание как «уже
     * отвечено»: клиент оставался без ответа, а в CRM ответ выглядел
     * отправленным. Хвост из недоставленных реплик бота пропускаем (их может быть
     * несколько — по одной на каждую сорвавшуюся попытку) и отвечаем на реплику
     * клиента перед ним.
     */
    let lastIdx = history.length - 1;
    while (lastIdx >= 0 && history[lastIdx].role === "assistant" && history[lastIdx].deliveryStatus === "failed") lastIdx--;
    const last = lastIdx >= 0 ? history[lastIdx] : undefined;
    if (!last || last.role !== "user" || !last.content) return;

    const outcome = await retryStuckConversation({
      id: conversation.id,
      channel: conversation.channel,
      subscriberId: conversation.subscriberId,
      name: conversation.name,
      accountId: conversation.accountId,
      lastText: last.content,
      lastMid: last.mid ?? null,
      lastMessageAt: conversation.lastMessageAt ?? new Date(),
    }, "ai_retry");
    // Модель всё ещё лежит или отправка не удалась — исключение отдаёт задание
    // очереди на следующую ступень лесенки (см. aiReplyRetryPolicy.ts).
    if (outcome === "ai-down") throw new Error("ИИ всё ещё недоступен");
    if (outcome === "failed") throw new Error("повтор не удался (подробности в журнале ошибок)");
  },
  async onGiveUp(payload) {
    /**
     * НЕПРОХОДИМЫЙ ХОД РАЗМЫКАЕТСЯ, А НЕ КРУТИТСЯ ВЕЧНО (07.09.2026, разбор
     * живого случая — переписка @nodira_laser, INSTAGRAM).
     *
     * ЧТО БЫЛО. Клиент прислал ФОТО ЧЕЛОВЕКА и спросил «он вам случайно не
     * знаком?». Опознание людей на фото Google запрещает своей политикой:
     * промт блокируется на входе (`blockReason=PROHIBITED_CONTENT`, пустой
     * ответ) — и будет блокироваться всегда, любой моделью, потому что дело не
     * в модели, а в содержимом хода. Дальше включалась петля:
     *   ход не отвечен → задание ai-reply-retry → 46 попыток за ~13 часов, все
     *   с одинаковым отказом → сдача → крон «здоровье системы» (каждые 30 минут)
     *   снова видит диалог без ответа и ставит НОВОЕ задание → всё сначала.
     * С 03.09 по 07.09 это дало 415 заданий и ~19 000 оплаченных вызовов Gemini
     * по ОДНОЙ переписке; в журнале ошибок за ними утонули настоящие проблемы
     * (741 запись, и почти все — эта петля), а живой клиент всё это время так и
     * не получил ответа, потому что позвать человека было некому.
     *
     * ЧТО ТЕПЕРЬ. Вторая сдача подряд по одному диалогу — это больше суток
     * одинаковых отказов, значит ход непроходим (чем бы это ни было: запретное
     * содержимое, битое вложение, слишком длинная история). Тогда:
     *   1) бот уходит с этого диалога на паузу — тем же полем `pausedUntil`,
     *      которым помечается «ведёт оператор», поэтому и findStuckConversations,
     *      и сам бот перестают его трогать, а кнопка «Вернуть боту» в интерфейсе
     *      возвращает всё назад одним нажатием, без правки базы;
     *   2) зовём ЖИВОГО человека — клиент ждёт ответа, и теперь это видно не
     *      строкой в журнале раз в 13 часов, а пушем тем, кто читает переписки.
     * Разрывать петлю именно здесь, а не по коду блокировки от Gemini: причина
     * бывает разной, а признак «сутки одинаковых отказов на фоне работающих
     * соседних диалогов» — общий для всех непроходимых ходов.
     */
    const giveUps = await prisma.backgroundJob.count({
      where: {
        type: "ai-reply-retry",
        status: "GIVEN_UP",
        updatedAt: { gte: new Date(Date.now() - GIVE_UPS_WINDOW_MS) },
        // Статус GIVEN_UP пишется ДО вызова onGiveUp (см. jobs/runner.ts),
        // поэтому текущая сдача уже посчитана.
        payload: { path: ["conversationId"], equals: payload.conversationId },
      },
    });

    if (giveUps < PERMANENT_AFTER_GIVE_UPS) {
      // Первая сдача — списываем на аварию поставщика: крон зайдёт ещё раз.
      // Клиенту по решению владельца НИЧЕГО не пишем, это видимость для персонала.
      await logSystemError(
        "ai",
        `Ход (${payload.conversationId}) не дождался ИИ за всё окно фонового повтора — клиенту ничего не отправлено`
      );
      return;
    }

    // botPausedAt — с какого момента началась пауза (шаг 5 переноса, 10.09.2026, см.
    // одноимённое поле схемы) — и одновременно снимок для эскалации 2ч/24ч ниже
    // (jobs/aiTurnBlockedFollowup.ts): по нему follow-up узнаёт, что это тот же эпизод.
    const botPausedAt = new Date();
    await prisma.botConversation.update({
      where: { id: payload.conversationId },
      data: { pausedUntil: new Date(Date.now() + OPERATOR_REPLY_PAUSE_MS), botPausedAt },
    });

    /**
     * СТУПЕНЬ «2 ЧАСА» УБРАНА (владелец 20.09.2026: «повторы вообще убери всем»
     * и «эскалация — прямо-таки пуш не нужно»). Она слала про одно и то же
     * ещё два уведомления: повтор тем же агентам («Бот 2 часа как не может
     * ответить») и эскалацию руководству. Остаётся ОДИН пуш агентам — тот, что
     * уходит ниже прямо сейчас, в момент, когда бот снялся с диалога.
     *
     * Ступень «24 часа» остаётся: пушей она не шлёт вовсе, только оставляет
     * запись, которая назавтра всплывает в утреннем отчёте директорам — это
     * страховка от молча потерянного диалога, а не уведомление.
     */
    const blockedAtIso = botPausedAt.toISOString();
    await enqueueBackgroundJob({
      type: "ai-turn-blocked-followup",
      payload: { conversationId: payload.conversationId, blockedAtIso, stage: "24h" },
      dedupeKey: `ai-turn-blocked-followup:24h:${payload.conversationId}`,
      maxAttempts: FOLLOWUP_MAX_ATTEMPTS,
      runAt: new Date(Date.now() + FOLLOWUP_24H_MS),
    });

    await logSystemError(
      "ai",
      `Ход (${payload.conversationId}) не проходит через ИИ ${giveUps}-й раз подряд (более суток одинаковых отказов) — ` +
        `бот снят с этого диалога, ответить должен человек. Причина почти всегда в содержимом переписки, которое ` +
        `модель отказывается обрабатывать (например, фото человека с просьбой опознать его). Откройте переписку в ` +
        `разделе «Сообщения»: ответьте руками, а вернуть бота можно кнопкой «Вернуть боту».`
    );

    // Пуш тем, кто читает переписки: клиент ждёт ответа живого человека.
    // Тег по диалогу — повторная сдача не должна давать второе уведомление.
    try {
      const recipients = await findAgentsWithPermission("messages.view");
      // Один запрос на всех получателей разом вместо sendPushToAgent на
      // каждого (22.09.2026).
      await sendPushToAgents(recipients, {
        title: "🤖 Бот не может ответить — нужен человек",
        body: "Переписка не проходит через ИИ больше суток. Клиент ждёт ответа.",
        url: `/messages?open=${payload.conversationId}`,
        tag: `ai-turn-blocked-${payload.conversationId}`,
      });
    } catch (err) {
      void logSystemError(
        "ai",
        `Не удалось позвать человека на непроходимый диалог ${payload.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  },
};
