import { z } from "zod";
import { contactProfileForPrompt } from "../lib/contactProfileMemory.js";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import type { ChatMessage } from "../ai/client.js";
import type { LeadDraft } from "../ai/leadQualifier.js";
import { runQualifyTurn } from "../ai/leadQualifier.js";
import { botAbilitiesOf, loadBotCapabilities } from "../messengers/botCapabilities.js";
import { finishTelegramDirectQualifyTurn, isTelegramDirectMessagesEnabled } from "../messengers/telegramDirectMessages.js";
import { isOperatorPauseActive } from "../lib/conversationState.js";
import { clientPhoneKnownOrDeleted } from "./telegramRetryGuards.js";
import type { JobHandler } from "./registry.js";
import { aiReplyRetryBackoffMs, BOT_TURN_JOB_TIMEOUT_MS } from "./aiReplyRetryPolicy.js";

/**
 * То же самое, что jobs/telegramReplyRetry.ts, но для Direct Messages канала
 * (TelegramDirectConversation — отдельная модель, см. докстринг
 * messengers/telegramDirectMessages.ts). Отдельный тип задания и файл, а не
 * ветка внутри telegramReplyRetryJob, — потому что таблица и функция
 * доставки (finishTelegramDirectQualifyTurn, topic_id) свои, и общий обработчик
 * пришлось бы разветвлять по каждому шагу; так короче и нагляднее.
 */
const schema = z.object({ conversationId: z.string() });

export const telegramDirectReplyRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: "telegram-dm-reply-retry",
  schema,
  backoff: aiReplyRetryBackoffMs,
  // Ход бота живёт до 75 с окна модели плюс доставка — общей минуты раннера
  // мало, удавшийся ход засчитывался сорвавшейся попыткой (№169 ночной
  // проверки 24.09). Тот же срок, что у telegramReplyRetry/aiReplyRetry.
  timeoutMs: BOT_TURN_JOB_TIMEOUT_MS,
  async run(payload) {
    const conversation = await prisma.telegramDirectConversation.findUnique({
      where: { id: payload.conversationId },
      select: {
        id: true,
        chatId: true,
        topicId: true,
        clientId: true,
        phoneAsksSent: true,
        messages: true,
        leadDraft: true,
        pausedUntil: true,
        contactProfileId: true,
      },
    });
    if (!conversation) return;
    /**
     * ТЕ ЖЕ ПРОВЕРКИ, ЧТО У ЖИВОГО ХОДА (03.10.2026, аудит audit-1, находка 14):
     * пауза — общей формулой isOperatorPauseActive (голый pausedUntil не снимался
     * протуханием и статусом клиента), рубильник бота (свой тумблер Direct Messages поверх общего), карточка в Корзине — как
     * jobs/aiReplyRetry.ts. Иначе отложенный ответ уходил после выключения бота
     * или в переписку удалённого клиента.
     */
    if (await isOperatorPauseActive(conversation.pausedUntil, null, conversation.clientId)) return;
    if (!(await isTelegramDirectMessagesEnabled())) return;
    const phoneKnown = await clientPhoneKnownOrDeleted(conversation.clientId);
    if (phoneKnown === "deleted") return;

    const history = (conversation.messages as unknown as ChatMessage[]) ?? [];
    const last = history.at(-1);
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
    if (!result) throw new Error("ИИ всё ещё недоступен");

    try {
      await finishTelegramDirectQualifyTurn({
        conversation: {
          id: conversation.id,
          clientId: conversation.clientId,
          phoneAsksSent: conversation.phoneAsksSent,
          contactProfileId: conversation.contactProfileId,
        },
        chatId: conversation.chatId,
        topicId: Number(conversation.topicId),
        draft,
        history,
        text: last.content,
        turn: result,
        capabilities,
        phoneKnown,
        pausedUntilAtStart: conversation.pausedUntil,
      });
    } catch (err) {
      throw new Error(`повтор не удался: ${describeError(err)}`);
    }
  },
  async onGiveUp(payload) {
    const conversation = await prisma.telegramDirectConversation.findUnique({
      where: { id: payload.conversationId },
      select: { id: true },
    });
    if (!conversation) return;

    /**
     * БОТ С ДИАЛОГА НЕ СНИМАЕТСЯ И ПУШ «КЛИЕНТ ЖДЁТ» НЕ УХОДИТ (аудит 23.09.2026, №37).
     *
     * Личные сообщения Telegram-канала раздел «Сообщения» не показывает и ответить
     * из CRM в них нельзя. Снятый бот означал, что клиенту не ответит уже никто, а
     * пуш вёл на «Диалог не найден». Пока ручного ответа для этого канала нет, бот
     * остаётся на диалоге: следующая реплика клиента снова пойдёт через ИИ. Отказ
     * пишется в «Здоровье», чтобы его было видно.
     */
    await logSystemError(
      "ai",
      `Ход (${payload.conversationId}, личные сообщения Telegram-канала) не дождался ИИ за всё окно фонового повтора — ` +
        `клиент остался без ответа на эту реплику. Ответить руками из CRM в этом канале пока нельзя: ` +
        `напишите клиенту из самого Telegram. Бот ответит на следующую реплику клиента.`
    );
  },
};
