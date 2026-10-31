import { z } from "zod";
import { contactProfileForPrompt } from "../lib/contactProfileMemory.js";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { sendPushToAgents } from "../push.js";
import { OPERATOR_REPLY_PAUSE_MS } from "../lib/conversationDelivery.js";
import type { ChatMessage } from "../ai/client.js";
import type { LeadDraft } from "../ai/leadDraft.js";
import { runQualifyTurn } from "../ai/leadQualifier.js";
import { botAbilitiesOf, loadBotCapabilities } from "../messengers/botCapabilities.js";
import { finishTelegramQualifyTurn } from "../telegram/bot.js";
import type { JobHandler } from "./registry.js";
import { aiReplyRetryBackoffMs, BOT_TURN_JOB_TIMEOUT_MS } from "./aiReplyRetryPolicy.js";
import { TG_PREFIX } from "../lib/conversationId.js";
import { isOperatorPauseActive } from "../lib/conversationState.js";
import { isBotEnabledForChannel } from "../messengers/botChannels.js";
import { clientPhoneKnownOrDeleted } from "./telegramRetryGuards.js";

/**
 * ОТЛОЖЕННЫЙ ОТВЕТ ИИ ДЛЯ ЛИЧНЫХ ЧАТОВ TELEGRAM, ПЕРЕЖИВАЮЩИЙ ДЕПЛОЙ.
 *
 * До 13.09.2026 повтор в Telegram жил в ai/aiRetryQueue.ts — setTimeout в
 * памяти процесса до ~13 часов, замыкание держало СНИМОК истории на момент
 * хода. Любой деплой (а их несколько в день) убивал ждущий ответ, а если
 * повтор всё же срабатывал, отвечал по УСТАРЕВШЕЙ истории — класс багов
 * «ответ из прошлого». Каналы Meta и сайт закрыли эту дыру 27.08.2026
 * (чертёж Б2, jobs/aiReplyRetry.ts): здесь тот же приём для Telegram —
 * задание переживает перезапуск и проигрывает ход ЗАНОВО по свежей истории,
 * прочитанной из БД в момент исполнения, через ту же finishTelegramQualifyTurn,
 * которой пользуется обычный (не повторный) ход — расхождение правил
 * («не здороваться дважды», «не бросать просьбу о номере») между обычным
 * ходом и повтором здесь невозможно: код один.
 *
 * Идемпотентность: перед проигрышем проверяется, что ПОСЛЕДНЯЯ реплика в
 * истории — клиентская (диалог не ушёл вперёд: ответил более свежий ход,
 * сам этот джоб в прошлой попытке, упавшей между отправкой и DONE, или
 * оператор руками).
 *
 * Вложения хода (фото/голос) в БД не сохраняются отдельно от истории —
 * повтор проигрывает ход по тексту, без картинок ровно так же, как повтор
 * зависших диалогов у каналов Meta (lib/stuckConversations.ts).
 */
const schema = z.object({ conversationId: z.string() });

export const telegramReplyRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: "telegram-reply-retry",
  schema,
  backoff: aiReplyRetryBackoffMs,
  // Ход бота: окно модели до 75 с плюс подготовка — минуты общего срока мало.
  timeoutMs: BOT_TURN_JOB_TIMEOUT_MS,
  async run(payload) {
    const conversation = await prisma.telegramConversation.findUnique({
      where: { id: payload.conversationId },
      select: {
        id: true,
        chatId: true,
        username: true,
        clientId: true,
        phoneAsksSent: true,
        messages: true,
        leadDraft: true,
        pausedUntil: true,
        botPausedAt: true,
        contactProfileId: true,
      },
    });
    // Диалог удалён / оператор уже ведёт руками — отвечать здесь нечего.
    if (!conversation) return;
    /**
     * ТЕ ЖЕ ПРОВЕРКИ, ЧТО У ЖИВОГО ХОДА (03.10.2026, аудит audit-1, находка 14):
     * пауза — общей формулой isOperatorPauseActive (голый pausedUntil не снимался
     * протуханием и статусом клиента), рубильник бота, карточка в Корзине — как
     * jobs/aiReplyRetry.ts. Иначе отложенный ответ уходил после выключения бота
     * или в переписку удалённого клиента.
     */
    if (await isOperatorPauseActive(conversation.pausedUntil, conversation.botPausedAt, conversation.clientId)) return;
    if (!(await isBotEnabledForChannel("TELEGRAM"))) return;
    const phoneKnown = await clientPhoneKnownOrDeleted(conversation.clientId);
    if (phoneKnown === "deleted") return;

    const history = (conversation.messages as unknown as ChatMessage[]) ?? [];
    const last = history.at(-1);
    // Диалог ушёл вперёд — на слова клиента уже кто-то ответил.
    if (!last || last.role !== "user" || !last.content) return;

    const draft = (conversation.leadDraft as unknown as LeadDraft) ?? { stage: "chatting" };
    const capabilities = await loadBotCapabilities();
    const abilities = botAbilitiesOf(capabilities);

    const result = await runQualifyTurn(history, draft, {
      images: [],
      abilities,
      conversationId: conversation.id,
      // Повтор после отказа модели читает то же досье, что и обычный ход: иначе
      // память бота работала бы «в основном режиме, но не при повторе».
      contactProfile: await contactProfileForPrompt(conversation.contactProfileId, draft),
      phoneKnown,
    });
    // Модель всё ещё лежит — исключение отдаёт задание очереди на следующую
    // ступень лесенки (см. aiReplyRetryPolicy.ts).
    if (!result) throw new Error("ИИ всё ещё недоступен");

    try {
      await finishTelegramQualifyTurn({
        conversation: {
          id: conversation.id,
          chatId: conversation.chatId,
          username: conversation.username,
          clientId: conversation.clientId,
          phoneAsksSent: conversation.phoneAsksSent,
          contactProfileId: conversation.contactProfileId,
        },
        draft,
        history,
        text: last.content,
        turn: result,
        capabilities,
        phoneKnown,
      });
    } catch (err) {
      throw new Error(`повтор не удался: ${describeError(err)}`);
    }
  },
  async onGiveUp(payload) {
    // Тот же приём разрыва петли, что в jobs/aiReplyRetry.ts (07.09.2026,
    // разбор @nodira_laser): непроходимый ход не крутится вечно, бот
    // снимается с диалога, зовём живого человека.
    const conversation = await prisma.telegramConversation.findUnique({
      where: { id: payload.conversationId },
      select: { id: true },
    });
    if (!conversation) return;

    await prisma.telegramConversation.update({
      where: { id: payload.conversationId },
      data: { pausedUntil: new Date(Date.now() + OPERATOR_REPLY_PAUSE_MS), botPausedAt: new Date() },
    });

    await logSystemError(
      "ai",
      `Ход (${payload.conversationId}, TELEGRAM) не дождался ИИ за всё окно фонового повтора — бот снят с этого ` +
        `диалога, ответить должен человек. Откройте переписку в разделе «Сообщения»: ответьте руками, а вернуть ` +
        `бота можно кнопкой «Вернуть боту».`,
      { url: `/messages?open=${TG_PREFIX}${payload.conversationId}` }
    );

    try {
      const recipients = await findAgentsWithPermission("messages.view");
      // Один запрос на всех получателей разом вместо sendPushToAgent на
      // каждого (22.09.2026).
      await sendPushToAgents(recipients, {
        title: "🤖 Бот не может ответить — нужен человек",
        body: "Переписка в Telegram не проходит через ИИ. Клиент ждёт ответа.",
        url: `/messages?open=${TG_PREFIX}${payload.conversationId}`,
        tag: `ai-turn-blocked-${payload.conversationId}`,
      });
    } catch (err) {
      void logSystemError(
        "ai",
        `Не удалось позвать человека на непроходимый диалог Telegram ${payload.conversationId}: ${describeError(err)}`
      );
    }
  },
};
