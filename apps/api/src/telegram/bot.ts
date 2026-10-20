import path from "node:path";
import { handleModerationCallback, handleModerationText, claimCallback } from "../lib/telegramModeration.js";
import { handleClipReviewCallback, handleClipReviewText } from "./clipReviewBot.js";
import { isOperatorPauseActive } from "../lib/conversationState.js";
import { prisma } from "../db.js";
import { sharedMediaHint } from "../messengers/sharedMedia.js";
import { isDuplicateDelivery, markProcessedMessageComplete, releaseProcessedMessage } from "../lib/webhookDedupe.js";
import { tryLinkAgentByCode, findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { sendShareTextMessage } from "../lib/agentSharePost.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";
import { handleMontajerVideo, handleMontajerReceiveCallback } from "./montajerReceive.js";
import { parseMontajerCallback, parseMontajerText, runMontajerCommand } from "./montajerBot.js";
import { appendTelegramConversationMessages } from "../messengers/conversation.js";
import { batchWindowFor, debounceAndMerge } from "../messengers/debounceBuffer.js";
import { markLastTelegramReplyUndelivered } from "../messengers/appendMessages.js";
import { deliverVoiceToConversation } from "../lib/conversationDelivery.js";
import { synthesizeChatVoiceReply, pcmToWavBuffer } from "../ai/tts.js";
import { isBotEnabledForChannel } from "../messengers/botChannels.js";
import { botAbilitiesOf, loadBotCapabilities } from "../messengers/botCapabilities.js";
import { notifyHumanAsk, routeMessengerCallbackRequest } from "../lib/callbackRequests.js";
import { acceptCallbackRequest } from "../ai/callbackRequest.js";
import { recordJobApplication, captureCandidate, candidateStoryCollected } from "../lib/jobApplications.js";
import { clientMeansHousingDeal } from "../ai/housingIntent.js";
import { shouldRecordJobApplication } from "../ai/adTemplateOpener.js";
import { storeFetchedAttachments } from "../messengers/attachments.js";
import { fetchTelegramAlbumAttachments, telegramUnsupportedMark } from "./attachments.js";
import { isTranscriptionEnabled, transcribeAudio } from "../ai/transcribe.js";
import { stripUntrusted, wrapUntrusted } from "../ai/untrustedContent.js";
import type { ChatMessage, ImageInput, StoredAttachment } from "../ai/client.js";
import {
  extractTypedPhone,
  extractVolunteeredPhone,
  lastClientLanguage,
  mergeDraft,
  normalizeDigits,
  runQualifyTurn,
  type LeadDraft,
} from "../ai/leadQualifier.js";
import { clientSelfStatedName, mentionsPhoneRequest, phoneReminder } from "../ai/replyGuards.js";
import { countPhoneAsksIn } from "../ai/replyRepeatGuard.js";
import { guardFired } from "../ai/guardMetrics.js";
import {
  FALLBACK_VOICE,
  finalizeBotReply,
  inClientLanguage,
  lastClientWords,
  recentBotText,
  silentTurnReason,
} from "../messengers/replyChain.js";
import {
  FALLBACK_ACCEPT_ERROR,
  FALLBACK_ACCEPTED,
  FOREIGN_CONTACT_REPLY,
  JOB_ACCEPTED_REPLY,
  JOB_TELL_ABOUT_YOURSELF,
  leadAcceptedReply,
} from "../messengers/leadAcceptedReply.js";
import { NEUTRAL_FIRST_REPLY } from "../ai/intentDirectionGuard.js";
import { isOtherCityReason } from "../ai/leadKind.js";
import { recordOwnerQuestion } from "../lib/ownerQuestions.js";
import { chatTypingPauseMs, sleep } from "../messengers/humanPacing.js";
import { noteRealInbound, repeatBlockedTexts } from "../lib/outboundShield.js";
import { screenIncomingText } from "../ai/inboundScreen.js";
import {
  loadPeerAiBudget,
  noticeAiBudgetHandover,
  spendAiFiles,
  spendAiTurns,
  type AiFileKind,
} from "../lib/aiDailyBudget.js";
import { createLeadFromChannel } from "../leads.js";
import { classifyInbound } from "../services/leads/intakePolicy.js";
import { looksLikeRentRequest, rentRefusalReply } from "../ai/rentGuard.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
// НОМЕР ОБЪЕКТА И «МНЕ НУЖЕН <ИМЯ>» — те же помощники, что уже работают в
// каналах Meta (messengers/conversation.ts). Ночная проверка 24.09.2026 (№2):
// в Telegram оба сигнала не распознавались вовсе, см. finishTelegramQualifyTurn.
import { detectRequestedAgent, requestedAgentNote, requestedAgentNotice } from "../lib/requestedAgent.js";
import { resolveBotPropertyMention, resolveMentionedPropertyId } from "../lib/botPropertyMention.js";
import {
  answerCallbackQuery,
  removeKeyboard,
  requestContact,
  sendChatAction,
  sendMessage,
  sendMessageWithButtons,
  setMessageReaction,
  type TelegramCallbackQuery,
  type TelegramDocument,
  type TelegramIncomingMessage,
  type TelegramUpdate,
} from "./api.js";
import { isOwnerChat } from "./ownerChat.js";
import { sendToMontajer } from "../lib/montageObservers.js";
import { tryHandleDealReviewReply } from "../lib/dealReviewIntake.js";
import { isWithinWorkingHours } from "../lib/workingHours.js";
import { notifyAgentOfClientMessage } from "../lib/clientMessageAlert.js";
import { scrubMentionedClientPhonesInText } from "../lib/clientPhoneMasking.js";
import { applyShowingRequestInBackground } from "../lib/showingBooking.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { AI_REPLY_RETRY_MAX_ATTEMPTS } from "../jobs/aiReplyRetryPolicy.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import {
  attachContactProfile,
  categoryForLeadKind,
  linkContactProfileToClient,
  recordContactTurn,
} from "../lib/contactProfiles.js";
import { recordAudienceMessage } from "../lib/audienceHeatmap.js";
import { contactProfileForPrompt, rememberContactTurn } from "../lib/contactProfileMemory.js";
import { collectSellerFacts } from "../ai/sellerIntake.js";
import { ingestGroupComment, isTelegramGroupCommentsEnabled } from "../messengers/telegramGroupComments.js";
import { handleTelegramDirectMessage } from "../messengers/telegramDirectMessages.js";
import { TG_PREFIX } from "../lib/conversationId.js";

async function getConversation(chatId: string, username: string | undefined) {
  // lastMessageAt — по нему инбокс «Сообщения» сортирует диалоги и считает «непрочитано».
  const lastMessageAt = new Date();
  const conversation = await prisma.telegramConversation.upsert({
    where: { chatId },
    update: { ...(username ? { username } : {}), lastMessageAt },
    create: { chatId, username, messages: [], leadDraft: { stage: "chatting" } as any, lastMessageAt },
  });
  // ДОСЬЕ СОБЕСЕДНИКА на первом же входящем — тот же шаг, что у Meta и у Direct
  // Messages (lib/contactProfiles.ts). chatId подтверждён самим Telegram, а ник
  // человек меняет когда захочет, поэтому связывать по нику автоматически
  // нельзя — он идёт как подсказка (PROFILE).
  const contactProfileId = await attachContactProfile({
    existingProfileId: conversation.contactProfileId,
    identities: [
      { kind: "TG_CHAT_ID", value: chatId, trust: "TRANSPORT" },
      { kind: "TG_USERNAME", value: username, trust: "PROFILE" },
    ],
    link: async (profileId) => {
      await prisma.telegramConversation.update({
        where: { id: conversation.id },
        data: { contactProfileId: profileId },
      });
    },
  });
  return { ...conversation, contactProfileId };
}

/**
 * КАРТОЧКА МОГЛА УЕХАТЬ В КОРЗИНУ (27.08.2026, продолжение аудита №4).
 *
 * Ровно та же защита, что стоит в handleMessage ниже, — вынесена сюда, потому
 * что диспетчер update'ов (dispatchTelegramUpdate) на callback_query зовёт
 * handleCallbackQuery и СРАЗУ возвращается: до handleMessage выполнение не
 * доходит никогда. Кнопка «Позвать агента» под старым приветствием читала
 * conversation.clientId напрямую и обходила защиту целиком — человек из Корзины
 * получал от бота «Передаю агенту», заявка не заводилась и не воскресала.
 *
 * Возвращает актуальный clientId: null, если карточка удалена (диалог уже
 * отвязан), иначе — тот же id.
 */
async function detachIfClientDeleted(conversation: { id: string; clientId: string | null }): Promise<string | null> {
  if (!conversation.clientId) return null;
  const owner = await prisma.client.findUnique({ where: { id: conversation.clientId }, select: { deletedAt: true } });
  if (owner && !owner.deletedAt) return conversation.clientId;
  await prisma.telegramConversation
    .update({ where: { id: conversation.id }, data: { clientId: null, leadDraft: { stage: "chatting" } as any } })
    .catch((err) => console.error("[telegram] отвязка диалога от удалённой карточки:", err));
  return null;
}

/**
 * Нажатие инлайн-кнопки. Сейчас единственная кнопка — «Позвать агента» на
 * приветствии, но диспетчер по callback_data сделан так, чтобы следующая
 * кнопка (например, «Показать похожие объекты») добавлялась одной веткой,
 * не переписывая обработчик целиком.
 */
async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  if (!chatId) {
    await answerCallbackQuery(query.id);
    return;
  }
  // Модерация объектов (lib/telegramModeration, 22.09.2026) — свой диспетчер tm:*.
  if (await handleModerationCallback(query)) return;
  // Проверка готового ролика (telegram/clipReviewBot.ts, 25.09.2026) — cr:*.
  if (await handleClipReviewCallback(query)) return;
  if (query.data === "call_agent") {
    // Диалог мог уже принять заявку (клиент нажал кнопку из старого сообщения
    // после того, как оформился заявкой текстом) — тогда просто подтверждаем,
    // не создавая вторую просьбу о звонке.
    const conversation = await prisma.telegramConversation.findUnique({ where: { chatId } });
    /**
     * КНОПКА ЖИВЁТ ПОД СТАРЫМ ПРИВЕТСТВИЕМ ВЕЧНО (ночная проверка 01.10.2026, №135).
     * Если диалог уже взял сотрудник (пауза оператора) или канал выключен рубильником,
     * обещать «агент свяжется» и заводить ещё одну просьбу о звонке нельзя: сотрудник
     * и так в переписке, а в выключенном канале бот молчит по решению владельца. Только
     * гасим «часики» на кнопке, ничего не создаём и ничего не пишем клиенту.
     */
    if (conversation) {
      const paused = await isOperatorPauseActive(conversation.pausedUntil, conversation.botPausedAt, conversation.clientId);
      if (paused || !(await isBotEnabledForChannel("TELEGRAM"))) {
        await answerCallbackQuery(query.id);
        return;
      }
    }
    await answerCallbackQuery(query.id, "Передаю агенту 🙌");
    if (conversation) {
      const liveClientId = await detachIfClientDeleted(conversation);
      const topic = "Клиент нажал кнопку «Позвать агента»";
      const capabilities = await loadBotCapabilities();
      /**
       * Кнопка живёт под старым приветствием вечно, и каждое нажатие — новый
       * update_id (дедуп доставок не спасает). До 26.08.2026 двадцать тапов
       * давали двадцать записей в очереди. Открытая просьба по диалогу уже есть —
       * подтверждаем клиенту и выходим, ничего не плодя.
       *
       * 22.09.2026: адресат — агент клиента, не дежурный оператор (тому только
       * входящие АТС). Агента нет — ветка ниже, обычная заявка в раздачу.
       */
      const open = capabilities.callback
        ? await prisma.callbackRequest.findFirst({
            where: { conversationId: conversation.id, doneAt: null },
            select: { id: true },
          })
        : null;
      const routedToAgent =
        capabilities.callback &&
        (!!open ||
          (await routeMessengerCallbackRequest({
            conversationId: conversation.id,
            clientId: liveClientId,
            channel: "TELEGRAM",
            topic,
          })));
      if (!routedToAgent) {
        /**
         * Дежурного оператора нет — кнопка не заводит отдельную очередь, а помечает
         * черновик заявки: клиента дальше ведёт обычная квалификация, и в карточку
         * поедет «просит перезвонить» (см. ai/callbackRequest.ts). Черновик обновляем
         * точечным слиянием, чтобы не затереть то, что бот уже успел выяснить.
         */
        const draft = (conversation.leadDraft as unknown as LeadDraft) ?? { stage: "chatting" };
        await prisma.telegramConversation
          .update({ where: { chatId }, data: { leadDraft: { ...draft, callbackTopic: topic } as any } })
          .catch(() => {
            // Пометка — удобство для агента, а не сам факт обращения: разговор
            // продолжается в любом случае, и заявка оформится обычным путём.
          });
      }
    }
    await sendMessage(chatId, "Хорошо! Наш агент свяжется с вами в ближайшее время. Если удобно, напишите номер телефона.");
    return;
  }
  // Кнопки меню монтажёра. Проверка «этот чат и правда монтажёр» — там же, где
  // и для текста: кнопка живёт под сообщением вечно, а назначенный монтажёр
  // в Настройках может смениться в любой день.
  if (query.data?.startsWith("mj:")) {
    // Двойное нажатие (25.09.2026, А2) — тот же claimCallback, что у "tm:"
    // (telegramModeration.ts): повтор не отрабатывает заново, только гасит
    // кнопку. Без этого «Прислать файлы заново» двумя тапами отправляла все
    // исходники дважды монтажёру и каждому наблюдателю.
    if (!(await claimCallback(query.id))) {
      await answerCallbackQuery(query.id);
      return;
    }
    await answerCallbackQuery(query.id);
    const agent = await findAgentByTelegramChatId(chatId);
    if (!agent || !(await isCurrentMontajer(agent.id))) {
      await sendToMontajer(chatId, "Этот чат сейчас не назначен монтажёром.", { copy: false }).catch(() => {});
      return;
    }
    // «Это №133» / «Ни то, ни другое» — ответ на вопрос, чей ролик (25.09.2026).
    if (query.data.startsWith("mj:rcv:")) {
      await handleMontajerReceiveCallback(chatId, agent.id, query.data);
      return;
    }
    // Меню — telegram/montajerBot.ts; незнакомая (старая) кнопка — меню заново.
    await runMontajerCommand(chatId, parseMontajerCallback(query.data) ?? { kind: "menu" });
    return;
  }
  // «📋 Текст поста» (28.09.2026, lib/agentSharePost.ts) — подпись отдельным
  // простым сообщением, чтобы её можно было скопировать целиком. Свой чат
  // проверять не нужно: кнопка сама по себе не отдаёт ничего, кроме текста,
  // который получатель уже видит в том же сообщении, под которым она стоит.
  if (query.data?.startsWith("share-text:")) {
    await answerCallbackQuery(query.id);
    const propertyId = query.data.slice("share-text:".length);
    await sendShareTextMessage(chatId, propertyId);
    return;
  }

  // Неизвестная кнопка (старая версия бота, устаревшая клавиатура) — гасим
  // индикатор загрузки и молчим, чтобы не плодить лишних ответов клиенту.
  await answerCallbackQuery(query.id);
}

/**
 * ОБРАБОТКА ОДНОГО ЧАТА — СТРОГО ПОСЛЕДОВАТЕЛЬНО (26.08.2026).
 *
 * В long polling порядок давал сам цикл поллера (await по одному апдейту). Вебхук
 * отвечает Telegram 200 ДО обработки, и следующий апдейт прилетает сразу: два
 * быстрых сообщения одного клиента обрабатывались ПАРАЛЛЕЛЬНО — оба читали одну
 * history и один draft, оба звали модель (двойной расход и два ответа на обрывки
 * одной мысли), а leadDraft писался last-write-wins: поля, собранные первым ходом,
 * молча терялись. Цепочка промисов на chatId возвращает прежний порядок; разные
 * чаты по-прежнему идут параллельно. Ошибка КОНКРЕТНОГО апдейта доходит до
 * вызывающего (вебхук/поллер по ней снимают замок дубля), но цепочку не рвёт.
 */
const chatChains = new Map<string, Promise<void>>();

/**
 * Апдейт принят: сообщение разобрано и лежит в переписке. `reply` — ответ бота,
 * который ждёт окно склейки (см. replyAfterWindow) уже ВНЕ цепочки чата:
 * иначе второе сообщение того же клиента встало бы в очередь за окном первого и
 * никогда не попало бы с ним в одну пачку. Обещание никогда не отклоняется —
 * сбой ответа пишется в журнал там же.
 */
export interface TelegramUpdateAccepted {
  reply: Promise<void>;
}

/**
 * Принять апдейт — без ожидания ответа бота (01.10.2026, находка №132). Нужен
 * поллеру: он разбирает апдейты ВСЕХ чатов по одному, и ждать в нём окно
 * склейки (по умолчанию 25 секунд) значило бы задержать на это время всех
 * остальных клиентов. Вебхук и тесты зовут handleTelegramUpdate ниже — она
 * дожидается и ответа.
 */
export function startTelegramUpdate(update: TelegramUpdate): Promise<TelegramUpdateAccepted> {
  const rawChatId = update.message?.chat?.id ?? update.callback_query?.message?.chat.id;
  const accepted = (r: TelegramUpdateAccepted | void): TelegramUpdateAccepted => r ?? { reply: Promise.resolve() };
  if (rawChatId == null) return dispatchTelegramUpdate(update).then(accepted);
  const key = String(rawChatId);
  const prev = chatChains.get(key) ?? Promise.resolve();
  const run = prev.then(() => dispatchTelegramUpdate(update));
  const tail = run.then(
    () => {},
    () => {}
  );
  chatChains.set(key, tail);
  void tail.then(() => {
    if (chatChains.get(key) === tail) chatChains.delete(key);
  });
  return run.then(accepted);
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const { reply } = await startTelegramUpdate(update);
  await reply;
}

async function dispatchTelegramUpdate(update: TelegramUpdate): Promise<TelegramUpdateAccepted | void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  const msg = update.message;
  if (!msg) return;

  /**
   * DIRECT MESSAGES КАНАЛА (01.09.2026) — ПРОВЕРКА ДО ветки "не приватный чат".
   *
   * chat.type у Direct Messages — "supergroup", ровно как у обычной группы:
   * без этой проверки апдейт провалился бы в handleDiscussionGroupMessage ниже
   * и молча терялся бы (chat.id не совпадает с discussionGroupId). Отличает
   * Direct Messages только chat.is_direct_messages (форма апдейта проверена
   * вживую через getUpdates 01.09.2026, см. messengers/telegramDirectMessages.ts).
   */
  if (msg.chat.is_direct_messages) {
    await handleTelegramDirectMessage(msg);
    return;
  }

  /**
   * ЛЮБОЙ ЧАТ, КРОМЕ ЛИЧНОГО, — НЕ КЛИЕНТ (01.09.2026, группа-обсуждение канала).
   *
   * До этой правки chat.type вообще не проверялся: TelegramConversation.upsert
   * ключуется голым chatId, и стоило боту оказаться в ЛЮБОЙ группе (обсуждение
   * канала, случайно добавили — не важно), как первое же сообщение там запускало
   * бы полную лид-квалификацию (GREETING, вопрос про телефон, воронку) на глазах
   * у всех участников группы. Единственный сценарий, где группа обрабатывается
   * вообще, — настроенная группа-обсуждение (см. handleDiscussionGroupMessage);
   * всё остальное молча пропускается.
   */
  if (msg.chat.type && msg.chat.type !== "private") {
    await handleDiscussionGroupMessage(msg);
    return;
  }

  // Личный чат СОТРУДНИКА с ботом (01.09.2026, привязка — lib/telegramAgentLink.ts) —
  // проверяется ДО альбомов/клиентской логики: это не клиент, и склеивать его
  // сообщения в клиентский диалог нельзя. /start <код> обрабатывается для любого
  // чата (это ровно тот момент, когда чат ЕЩЁ не привязан).
  if (await handleAgentTelegramMessage(msg, update.update_id)) return;

  // Альбом: клиент отправил несколько фотографий одной пачкой — Telegram доставляет
  // их отдельными сообщениями. Копим и разбираем одним обращением (см. bufferAlbum).
  if (msg.media_group_id) {
    bufferAlbum(msg, String(update.update_id));
    return;
  }
  return handleClientMessages([msg]);
}

/** Сообщение из ЛЮБОЙ группы/супергруппы — не только настроенной группы-обсуждения:
 *  бот молча выходит из чужих групп по этому же пути, если его туда добавят
 *  случайно, поскольку ничего, кроме комментариев под своими постами, не умеет. */
async function handleDiscussionGroupMessage(msg: TelegramIncomingMessage): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } });
  const groupId = settings?.telegramDiscussionGroupId;
  if (!groupId || String(msg.chat.id) !== groupId) return;
  // Выключенный бот НЕ повод потерять комментарий: принимаем и закрываем пометкой
  // "bot_off" — так же, как Instagram/Facebook (см. ingestGroupComment). Раньше
  // здесь стоял `return`, и комментарии за время выключенного бота исчезали совсем:
  // Telegram второй раз их не доставит, а в ленте CRM их не было вовсе.
  const enabled = await isTelegramGroupCommentsEnabled({ discussionGroupId: groupId });
  await ingestGroupComment(msg, groupId, enabled);
}

/**
 * Личный чат сотрудника с CRM-ботом (01.09.2026) — сейчас единственное
 * применение: привязка по коду и приём готового ролика от монтажёра
 * (lib/videoHandoff.ts). true — сообщение разобрано здесь и клиентскую логику
 * трогать не нужно; false — обычный клиент, дальше по обычному пути.
 *
 * САМАЯ ЧУВСТВИТЕЛЬНАЯ ТОЧКА этой правки: должна безошибочно отличать чужого
 * клиента от своего сотрудника и НИКОГДА не перехватывать реальный клиентский
 * диалог. Порядок: сначала /start <код> (чат ещё не привязан ни к кому — самый
 * частый случай для остальных клиентов, отсекается быстро), потом проверка
 * привязки по chatId (сотрудники — редкое меньшинство чатов бота).
 */
/** Расширения, по которым документ считается видео, если mime-тип не помог
 *  (23.09.2026, находка B1: частый .mov с айфона Telegram шлёт без mime_type
 *  вовсе). Регистр расширения — любой, поэтому сравнение через toLowerCase. */
const VIDEO_DOCUMENT_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".mkv", ".avi", ".webm"]);

/** Документ — видео и по MIME, и по расширению файла. До этой правки документ
 *  без `mime_type video/*` (ровно тот частый .mov) проваливался в текстовый
 *  разбор ниже, и ролик молча терялся — монтажёр получал в ответ статус очереди
 *  и не понимал, что случилось. */
function isVideoDocumentAttachment(document: TelegramDocument | undefined): boolean {
  if (!document) return false;
  if (document.mime_type?.startsWith("video/")) return true;
  return VIDEO_DOCUMENT_EXTENSIONS.has(path.extname(document.file_name?.toLowerCase() ?? ""));
}

/** Назначенный монтажёр (Settings.videoMontajerAgentId) — один; старая привязка
 *  другого сотрудника не должна суметь ни сдать ролик, ни читать меню монтажёра. */
async function isCurrentMontajer(agentId: string): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  return settings?.videoMontajerAgentId === agentId;
}

async function handleAgentTelegramMessage(msg: TelegramIncomingMessage, updateId: number): Promise<boolean> {
  const chatId = String(msg.chat.id);

  const startMatch = msg.text?.match(/^\/start\s+(\S+)/);
  if (startMatch) {
    const linked = await tryLinkAgentByCode(chatId, startMatch[1]);
    if (linked) return true;
    // Код не подошёл (истёк, чужой, уже использован) — это мог быть и клиент,
    // случайно написавший "/start что-то": не отвечаем здесь ничего, пусть
    // разберёт обычная клиентская логика ниже (return false).
  }

  const agent = await findAgentByTelegramChatId(chatId);
  if (!agent) return false;

  // Ответ модератора на вопрос бота («комментарий агенту», «новое значение поля») —
  // состояние в базе с TTL 15 минут, см. lib/telegramModeration.ts.
  if (msg.text && !msg.text.startsWith("/") && (await handleModerationText(chatId, msg.text))) return true;
  // Комментарий монтажёру к возврату готового ролика (telegram/clipReviewBot.ts).
  if (msg.text && !msg.text.startsWith("/") && (await handleClipReviewText(chatId, msg.text))) return true;

  /**
   * ОБЛОЖКА ОТ МОНТАЖЁРА БОЛЬШЕ НЕ ПРИНИМАЕТСЯ (владелец, 21.09.2026: «обложки
   * будем мы с тобой генерировать»). Публикация всегда берёт обложку кадром из
   * самого ролика (lib/videoHandoff.ts::extractCoverFrame). Фото от монтажёра
   * просто отвечаем одной понятной строкой, ничего не сохраняя.
   */
  if (msg.photo?.length) {
    await sendToMontajer(chatId, "Обложки теперь делаем сами — присылать не нужно, просто пришлите готовый ролик.", {
      copy: false,
    }).catch(() => {});
    return true;
  }

  // Кружок (video_note) Telegram сжимает сам — качество ролика для публикации
  // важнее удобства присылки, поэтому просим переслать файлом и ничего не
  // скачиваем и не трогаем в объекте (23.09.2026, находка B1).
  if (msg.video_note) {
    await sendToMontajer(
      chatId,
      "Кружок не подходит — пришлите ролик ФАЙЛОМ (скрепка → Файл), чтобы Telegram его не пережал.",
      { copy: false }
    ).catch(() => {});
    return true;
  }

  const isVideoDocument = isVideoDocumentAttachment(msg.document);
  const video = msg.video ?? (isVideoDocument ? msg.document : undefined);

  // Любое другое вложение (не фото, не кружок, не видео) — явный ответ, что
  // именно пришло и что мы ждём, а не статус очереди (23.09.2026, находка B1).
  if (!video && (msg.voice || msg.audio || msg.sticker || msg.animation)) {
    const label = msg.voice ? "голосовое" : msg.audio ? "аудиофайл" : msg.sticker ? "стикер" : "гиф-анимацию";
    await sendToMontajer(chatId, `Пришло ${label}, а мы ждём готовый ролик — пришлите его ФАЙЛОМ (скрепка → Файл).`, {
      copy: false,
    }).catch(() => {});
    return true;
  }

  if (video) {
    // Чат привязан к сотруднику, но монтажёра сейчас назначают ОДНОГО — чужая
    // старая привязка не должна суметь забрать чужую очередь передачи.
    if (!(await isCurrentMontajer(agent.id))) {
      await sendToMontajer(chatId, "Этот чат сейчас не назначен монтажёром — передавать ролик некому.", {
        copy: false,
      }).catch(() => {});
      return true;
    }
    // Чей это ролик, вопрос «для №133 или №136?», ворота и квитанция —
    // telegram/montajerReceive.ts (25.09.2026).
    await handleMontajerVideo({
      chatId,
      agentId: agent.id,
      updateId,
      fileId: video.file_id,
      filename: isVideoDocument ? msg.document?.file_name ?? "video.mp4" : "video.mp4",
      caption: msg.caption ?? null,
      albumGroupId: msg.media_group_id,
    });
    return true;
  }

  // Сотрудник в личном чате, но не ролик и не /start — не клиентский диалог.
  // Текущему монтажёру любое его сообщение сюда — команда меню (слова и кнопки
  // делают одно и то же, telegram/montajerBot.ts); незнакомое — статус очереди
  // (владелец 16.09.2026, «чтобы монтажёр всегда видел очередь объектов»).
  if (!(await isCurrentMontajer(agent.id))) {
    await sendToMontajer(chatId, "Это личный чат с CRM-ботом. Пришлите файлом готовый ролик, когда он ждёт монтажа.", {
      copy: false,
    }).catch(() => {});
    return true;
  }
  await runMontajerCommand(chatId, parseMontajerText(msg.text ?? ""));
  return true;
}

/** Часть альбома? Вебхук и поллер по этому признаку НЕ ставят дедуп-отметку сразу:
 *  для альбома она ставится в момент склейки (см. bufferAlbum) — иначе рестарт в
 *  окне буфера терял пачку фото безвозвратно (отметка есть, буфер в памяти умер,
 *  повторную доставку дедуп отбрасывал). Найдено аудитом 26.08.2026. */
export function isAlbumPart(update: TelegramUpdate): boolean {
  return Boolean(update.message?.media_group_id);
}

/**
 * Окно склейки альбома.
 *
 * Части альбома Telegram отдаёт подряд, обычно в одном ответе getUpdates, — двух
 * секунд тишины хватает с запасом. Потолок нужен на случай медленной доставки: с
 * ним последняя часть подождёт не дольше десяти секунд, а ответ клиенту не зависнет
 * из-за одной потерявшейся картинки.
 *
 * Окно намеренно узкое: здесь склеивается ОДНО отправление, части которого летят
 * миллисекундами друг за другом. Ждать даже несколько секунд ответа на присланное
 * фото клиент не станет.
 */
const ALBUM_WINDOW_MS = 2_000;
const ALBUM_MAX_WAIT_MS = 10_000;

interface PendingAlbum {
  msgs: TelegramIncomingMessage[];
  /** update_id каждой части — дедуп-отметка ставится в момент СКЛЕЙКИ, не приёма. */
  updateIds: string[];
  timer: NodeJS.Timeout;
  firstAt: number;
}
/** Ключ — чат и группа: один человек может прислать два альбома подряд, и смешивать
 *  их нельзя. Буфер в памяти процесса: переживать перезапуск ему незачем — с
 *  26.08.2026 отметка «обработано» ставится только при склейке, поэтому потерянная
 *  при рестарте пачка честно ПРИДЁТ ПОВТОРНО через поллер, а не пропадёт (раньше
 *  части помечались обработанными при приёме, и дедуп отбрасывал повторную доставку
 *  умершего вместе с буфером альбома). */
const pendingAlbums = new Map<string, PendingAlbum>();

function bufferAlbum(msg: TelegramIncomingMessage, updateId: string): void {
  const key = `${msg.chat.id}:${msg.media_group_id}`;
  const existing = pendingAlbums.get(key);
  const firstAt = existing?.firstAt ?? Date.now();
  const msgs = existing ? [...existing.msgs, msg] : [msg];
  const updateIds = existing ? [...existing.updateIds, updateId] : [updateId];
  if (existing) clearTimeout(existing.timer);

  const flush = () => {
    pendingAlbums.delete(key);
    // Таймер живёт вне цепочки промисов вызывающего кода: необработанный отказ отсюда
    // ушёл бы в unhandledRejection и уронил процесс — гасим его на месте.
    void (async () => {
      // Отметки — здесь, по одной на часть. Уже отмеченные части (альбом успешно
      // склеен раньше, а поллер после рестарта доставил их снова) отбрасываются:
      // без этого повторная доставка дала бы клиенту второй ответ на тот же альбом.
      const fresh: TelegramIncomingMessage[] = [];
      const freshIds: string[] = [];
      for (let k = 0; k < msgs.length; k++) {
        if (!(await isDuplicateDelivery("TELEGRAM", updateIds[k]))) {
          fresh.push(msgs[k]);
          freshIds.push(updateIds[k]);
        }
      }
      if (fresh.length === 0) return;
      let reply: Promise<void> | undefined;
      try {
        reply = (await handleClientMessages(fresh))?.reply;
        // Отметка завершения (21.09.2026, см. lib/webhookDedupe.ts) — без неё
        // зависшая (не снятая явным catch) отметка после рестарта посреди
        // разбора альбома считалась бы обработанной лишь до истечения окна
        // «зависла», а не навсегда, как задумано для успешно склеенной пачки.
        for (const id of freshIds) void markProcessedMessageComplete("TELEGRAM", id);
      } catch (err) {
        console.error("[telegram] разбор альбома:", err instanceof Error ? err.message : err);
        // Транзиентный сбой не должен съесть пачку фото: снимаем отметки, повторная
        // доставка обработает заново — тем же правилом, что у одиночных сообщений.
        for (const id of freshIds) void releaseProcessedMessage("TELEGRAM", id);
      }
      // Ответ на альбом ждёт окно склейки — уже после отметок: фото в переписке,
      // и повторная доставка их бы только задвоила.
      if (reply) await reply;
    })();
  };

  const delay = Math.max(0, Math.min(ALBUM_WINDOW_MS, ALBUM_MAX_WAIT_MS - (Date.now() - firstAt)));
  pendingAlbums.set(key, { msgs, updateIds, firstAt, timer: setTimeout(flush, delay) });
}

/**
 * Окончание хода ИИ в личке с ботом — вынесено из handleClientMessages ОБЩЕЙ
 * функцией (13.09.2026, чертёж Б2 для Telegram), чтобы её же вызывал и живой
 * ход, и персистентный повтор jobs/telegramReplyRetry.ts. Раньше это была
 * замыкание-функция finishTurn ВНУТРИ handleClientMessages: фоновый повтор
 * (ai/aiRetryQueue.ts) держал её в памяти процесса вместе со СНИМКОМ истории —
 * любой деплой убивал ожидающий ответ, а при удаче ответ уходил по УСТАРЕВШЕЙ
 * истории, а не по свежей из БД. Теперь и живой ход, и повтор зовут это же тело
 * с историей/черновиком, прочитанными в момент вызова — второго пути нет.
 */
export async function finishTelegramQualifyTurn(params: {
  /* phoneAsksSent обязателен в типе — см. пояснение в telegramDirectMessages.ts. */
  conversation: {
    id: string;
    chatId: string;
    username: string | undefined | null;
    clientId: string | null;
    phoneAsksSent: number;
    /** Досье собеседника — память бота о человеке (lib/contactProfileMemory.ts). */
    contactProfileId?: string | null;
  };
  draft: LeadDraft;
  history: ChatMessage[];
  text: string;
  turn: NonNullable<Awaited<ReturnType<typeof runQualifyTurn>>>;
  capabilities: Awaited<ReturnType<typeof loadBotCapabilities>>;
  /** Клиент в ЭТОМ ходе прислал голосовое — условие для голосового ответа
   *  (см. докстринг у синтеза ниже). Повтор из jobs/telegramReplyRetry.ts
   *  голосового вложения уже не видит — честно false, а не угадывание. */
  incomingWasVoice?: boolean;
  /** Номер уже в карточке — второй раз его не просим (тот же признак, что и
   *  в промте runQualifyTurn; живой ход и повтор передают одно и то же). */
  phoneKnown?: boolean;
}): Promise<void> {
  const { conversation, draft, history, text, turn, capabilities, incomingWasVoice = false, phoneKnown = false } = params;
  const chatId = conversation.chatId;
  /**
   * «МНЕ НУЖЕН УМЕД» И «ОБЪЕКТ №112» — ТЕ ЖЕ ДВА СИГНАЛА, ЧТО В КАНАЛАХ META
   * (ночная проверка 24.09.2026, находка №2). До этой правки оба распознавались
   * только в messengers/conversation.ts: клиент, писавший в Telegram «объект
   * №112, сколько стоит», уходил в общую очередь по KPI вместо хозяина объекта,
   * а «мне нужен Умед» тут вообще не читалось. Вычисляется по словам этого хода
   * (`text`), тем же кодом, что и в conversation.ts, — найденное кладётся в
   * черновик ниже и используется при оформлении заявки (createLeadFromChannel
   * в handleClientMessages).
   */
  const requestedAgent = await detectRequestedAgent(text);
  const mentionedPropertyId = await resolveMentionedPropertyId(text);
  // `text` — слова самого клиента: по ним код отсекает аренду, не полагаясь на
  // то, что модель прочла запрет в промте (см. ai/rentGuard.ts).
  const mergedDraft = mergeDraft(draft, turn, text);
  // Этап «ждём номер» ЛИПНЕТ, как в каналах Meta (conversation.ts): модель могла
  // сбросить ready на очередном ходе, и без этой строки просьба о номере молча
  // слетала — extractTypedPhone переставал принимать продиктованный номер, а
  // ensurePhoneAskKept переставал дописывать напоминание (живой баг 11.08,
  // починенный тогда только в одном канале из двух; Telegram догнал 26.08.2026).
  if (draft.stage === "awaiting_phone") mergedDraft.stage = "awaiting_phone";

  /**
   * Названный сотрудник и названный объект запоминаются в черновике, а не
   * применяются сейчас: заявки ещё нет, она оформится позже, когда клиент
   * назовёт телефон (см. createLeadFromChannel в handleClientMessages). Тот же
   * приём и тот же порядок, что в messengers/conversation.ts.
   */
  if (requestedAgent.status === "matched") mergedDraft.requestedAgentId = requestedAgent.agentId;
  const namedNote = requestedAgentNote(requestedAgent);
  if (namedNote) mergedDraft.requestedAgentNote = namedNote;
  // Описанное объявление — тем же узнаванием, что звонок и каналы Meta.
  const describedPropertyId = mentionedPropertyId
    ? null
    : await resolveBotPropertyMention(text, mergedDraft).catch((err) => {
        void logSystemError("ai", `Telegram: узнавание объекта по описанию не выполнено: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
  const namedPropertyId = mentionedPropertyId ?? describedPropertyId;
  if (namedPropertyId) mergedDraft.requestedPropertyId = namedPropertyId;

  // Запрос звонка и анкета кандидата — те же записи, что в каналах Meta: канал
  // другой, механика одна (см. lib/callbackRequests.ts, lib/jobApplications.ts).
  // Развилка по рубильнику «Соединять с оператором» — тоже общая: есть дежурный —
  // отдельная запись и авто-соединение, нет — обычная заявка агенту с пометкой в
  // карточке (см. ai/callbackRequest.ts).
  // 22.09.2026: засчитываем только явную просьбу в словах клиента; оператор
  // не адресат — агент клиента или раздача (см. ai/callbackRequest.ts).
  const callbackTopic = acceptCallbackRequest(turn.callbackRequest, text, {
    // По намерению разговора, а не по полю модели этого хода (02.10.2026).
    isJobApplication: shouldRecordJobApplication(mergedDraft.intent, undefined),
  });
  if (callbackTopic) {
    const routedToAgent =
      capabilities.callback &&
      (await routeMessengerCallbackRequest({
        conversationId: conversation.id,
        clientId: conversation.clientId,
        channel: "TELEGRAM",
        topic: callbackTopic,
      }));
    if (!routedToAgent) {
      mergedDraft.callbackTopic = callbackTopic;
      // Прямая просьба о живом человеке — один пуш, как в messengers/conversation.ts.
      void notifyHumanAsk({
        conversationId: conversation.id,
        clientId: conversation.clientId,
        channel: "TELEGRAM",
        topic: callbackTopic,
        clientText: text,
      });
    }
  } else if (turn.callbackRequest && !turn.jobApplication) {
    // Просьбы не было — модель придумала; см. тот же счётчик в
    // messengers/conversation.ts.
    guardFired("callback_not_asked");
  }
  /**
   * «УТОЧНЮ У СОБСТВЕННИКА» — ОБЕЩАНИЕ СТАНОВИТСЯ ЗАПИСЬЮ (03.10.2026, аудит
   * audit-1, находка 3). Промт (ASK_OWNER_PROMPT_RULE) говорит модели, что ответ
   * дойдёт до клиента сам, а Telegram запись не заводил вовсе — клиент ждал ответа,
   * которого не будет никогда. Теперь как в каналах Meta: запись в очередь
   * вопросов собственнику, ответ уходит в эту же личку (lib/ownerQuestionAnswer.ts
   * знает TelegramConversation). Не ждём: ход не зависит от записи.
   */
  if (turn.askOwner && capabilities.askOwner) {
    void recordOwnerQuestion({
      conversationId: conversation.id,
      clientId: conversation.clientId,
      question: turn.askOwner,
    });
  }
  /**
   * АНКЕТА ПИШЕТСЯ ТОЛЬКО НА РАЗГОВОРЕ О РАБОТЕ (25.09.2026, аудит «кто вообще
   * кандидат» — то же правило, что и в messengers/conversation.ts). Раньше
   * анкета копилась на ЛЮБОМ ходе, где модель вернула поле jobApplication,
   * независимо от намерения — живые цифры за 7 дней: 72 анкеты, из них intent
   * job только 29, sell 35. У Telegram-бота нет рекламной атрибуции (adTopic
   * живёт только у BotConversation каналов Meta), поэтому здесь единственный
   * признак — итоговый intent этого хода (mergedDraft, слитый черновик).
   */
  if (turn.jobApplication && shouldRecordJobApplication(mergedDraft.intent, undefined)) {
    void recordJobApplication({
      conversationId: conversation.id,
      channel: "TELEGRAM",
      contactName: conversation.username,
      contactProfileId: conversation.contactProfileId,
      draft: turn.jobApplication,
    });
    // Принятый клиент заговорил о работе — снять карточку с агента и позвать
    // руководство один раз, как в каналах Meta (02.10.2026).
    const clientWordsSoFar = [...history.filter((m) => m.role === "user").map((m) => m.content), text].join("\n");
    if (conversation.clientId && !clientMeansHousingDeal(clientWordsSoFar)) {
      void captureCandidate({
        table: "telegram",
        conversationId: conversation.id,
        channel: "TELEGRAM",
        name: conversation.username,
        knownClientId: conversation.clientId,
      });
    }
  }
  /**
   * ЦЕПОЧКА ФИЛЬТРОВ ОТВЕТА — ТА ЖЕ ФУНКЦИЯ, ЧТО У КАНАЛОВ META И САЙТА
   * (messengers/replyChain.ts::filterBotReply; Dan 03.10.2026, «один мозг»).
   * Раньше здесь жила своя копия, и в ней не было четырёх рубежей: про найм —
   * только кандидату, не угадывать «покупаете или продаёте», «номер уже наш» и
   * заглушка «не расслышал» по-русски даже тогда, когда ответ вычистили наши же
   * проверки (аудит audit-1, находки 7 и 9).
   *
   * Удержание темы здесь не действует: состояние темы хранят только колонки
   * BotConversation, у TelegramConversation их нет — фильтр получает пустое
   * состояние и ничего не дописывает.
   */
  const botSpokeBefore = history.some((m) => m.role === "assistant");
  const botSaidBefore = history.filter((m) => m.role === "assistant").map((m) => m.content);
  const clientSaidTrusted = stripUntrusted(
    `${history
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")} ${text}`,
    ["document", "video"]
  );
  const turnLanguageRaw = detectClientLanguage(text);
  const turnLanguage = turnLanguageRaw === "unknown" ? lastClientLanguage(history) : turnLanguageRaw;
  const requestedNotice = requestedAgentNotice(requestedAgent, detectClientLanguage(text));
  // Ответ съели фильтры — не молчим (аудит 10.10.2026, P0-1): повторить ход модели
  // здесь нечем (окончание хода общее с фоновым повтором), поэтому сразу короткая
  // нейтральная реплика; щит исходящих спрашиваем заранее.
  const filtered = await finalizeBotReply({
    reply: turn.reply,
    conversationId: conversation.id,
    channelLabel: "TELEGRAM",
    openUrl: `/messages?open=${TG_PREFIX}${conversation.id}`,
    botSpokeBefore,
    botSaidBefore,
    clientSaidTrusted,
    clientTurnText: text,
    previousBotText: recentBotText(history),
    language: turnLanguage,
    draft: mergedDraft,
    jobConversation: mergedDraft.intent === "job",
    phoneAsksSent: conversation.phoneAsksSent ?? 0,
    phoneKnown,
    requestedAgent,
    requestedNotice,
    fallbackLanguageWords: [text, lastClientWords(history)],
  }, { shieldBlocked: (bubbles) => repeatBlockedTexts("TELEGRAM", chatId, bubbles) });
  const replyBubbles = filtered.bubbles;

  // ПАУЗУ ПЕРЕЧИТЫВАЕМ ПОСЛЕ МОДЕЛИ (ночная проверка 24.09.2026). Единственная
  // проверка pausedUntil стояла в handleClientMessages ДО вызова модели; агент,
  // взявший диалог из инбокса, пока бот думал (секунды, а с повтором — минуты),
  // получал ответ бота поверх своего. Повтор jobs/telegramReplyRetry.ts паузу
  // проверяет — дыра была только в живом ходе. Слова клиента уже в переписке;
  // молчание — в журнал, как в messengers/conversation.ts.
  //
  // Та же формула, что и при первой проверке паузы выше (находка №114, тот же
  // класс: голый `pausedUntil > now()` не снимался ни протуханием, ни статусом
  // LOST/ARCHIVED/INACTIVE) — иначе брошенный клиент, у которого «бессрочная»
  // пауза уже признана протухшей, получал бы здесь повторное молчание.
  const pausedNow = await prisma.telegramConversation.findUnique({
    where: { id: conversation.id },
    select: { pausedUntil: true, botPausedAt: true, clientId: true },
  });
  if (pausedNow && (await isOperatorPauseActive(pausedNow.pausedUntil, pausedNow.botPausedAt, pausedNow.clientId))) {
    void logSystemError(
      "ai",
      `Сотрудник взял диалог ${conversation.id} (TELEGRAM), пока бот готовил ответ, — ответ бота не отправлен.`,
      { url: `/messages?open=${conversation.id}` }
    );
    return;
  }

  // Дописываем только ответ бота: слова клиента записаны выше, ДО обращения к
  // модели (иначе при отказе ИИ они терялись целиком). Пустой реплики в
  // переписке быть не должно — ход, погашенный защитой от повтора, оставляет
  // след в журнале выше, а не пузырь-пустышку в инбоксе.
  /* Счётчик просьб номера — по реально ушедшим пузырям (просьбу мог вычеркнуть
   * dropPhoneAsks) и прибавкой в самой БД, чтобы параллельный ход не затёрся. */
  const phoneAsksJustSent = countPhoneAsksIn(replyBubbles);
  if (phoneAsksJustSent > 0) {
    await prisma.telegramConversation
      .update({ where: { id: conversation.id }, data: { phoneAsksSent: { increment: phoneAsksJustSent } } })
      .catch(() => {});
  }
  if (replyBubbles.length > 0) {
    await appendTelegramConversationMessages(conversation.id, [
      { role: "assistant", content: replyBubbles.join("\n"), by: { kind: "bot" } },
    ]);
  }
  await prisma.telegramConversation.update({
    where: { chatId },
    data: { leadDraft: mergedDraft as any },
  });
  // Досье человека пополняется тем же ходом, что и черновик диалога — одна и та же
  // функция во всех каналах (lib/contactProfileMemory.ts).
  await rememberContactTurn({
    profileId: conversation.contactProfileId,
    conversationId: conversation.id,
    draft: mergedDraft,
    sellerFacts: mergedDraft.intent === "sell" ? collectSellerFacts(history) : null,
    selfName: clientSelfStatedName(history),
  });

  /**
   * ОТПРАВКА — ПОД ОТМЕТКОЙ «НЕ ДОСТАВЛЕНО» (правка 22.09.2026).
   *
   * Реплика уже лежит в переписке (иначе к ней нечего было бы привязывать и
   * отказ ИИ терял бы слова клиента), а `sendMessage` бросает на любой отказ Bot
   * API: человек заблокировал бота, 403, 429, таймаут. Telegram наш 200 уже
   * получил, повтора не будет. Без отметки сотрудник видит в инбоксе «бот
   * ответил» и сам не пишет — человек остаётся без ответа вообще. Тот же класс
   * чинили 20.09 в каналах Meta (markLastReplyUndelivered).
   *
   * Метим ТОЛЬКО когда не ушёл ни один пузырь: пузырей может быть несколько, а
   * элемент переписки один, и «первый дошёл, второй нет» честно пометить нечем.
   */
  let deliveredAny = false;
  try {
    /**
     * ПРОСЬБА О НОМЕРЕ — БЕЗ «ЗАПИСАЛ: …» И БЕЗ ВТОРОЙ РУССКОЙ ПРОСЬБЫ (03.10.2026,
     * аудит audit-1, находка 5; в Direct Messages то же с 02.10.2026). Раньше по
     * `turn.ready` к ответу дописывалось «Записал: бюджет …» анкетой по-русски и
     * ещё одна русская просьба номера — следом за пузырём, где модель (или
     * ensurePhoneAskKept) номер уже попросила на языке клиента, мимо счётчика
     * просьб и мимо переписки. Другой город, заграница и аренда тоже получали
     * «чтобы агент мог связаться», хотя mergeDraft нарочно не переводит их в
     * «ждём номер».
     *
     * Теперь — по этапу awaiting_phone. Просьба уже есть в ответе — кнопка
     * «Поделиться номером» встаёт под ЭТИМ пузырём, второго сообщения нет. Нет —
     * добавляется общая phoneReminder на языке клиента, только если предел не
     * исчерпан и прошлым сообщением мы номер не просили; с учётом в счётчике и в
     * переписке.
     */
    const awaitingPhone = mergedDraft.stage === "awaiting_phone" && !conversation.clientId && replyBubbles.length > 0;
    const askIndex = awaitingPhone ? replyBubbles.findIndex((b) => countPhoneAsksIn([b]) > 0) : -1;
    const extraAsk =
      awaitingPhone &&
      askIndex < 0 &&
      !filtered.stopAskingPhone &&
      !mentionsPhoneRequest(recentBotText(history))
        ? phoneReminder(turnLanguage)
        : null;
    if (extraAsk) {
      await appendTelegramConversationMessages(conversation.id, [{ role: "assistant", content: extraAsk, by: { kind: "bot" } }]);
      await prisma.telegramConversation
        .update({ where: { id: conversation.id }, data: { phoneAsksSent: { increment: 1 } } })
        .catch((err) => console.error("[telegram] счётчик просьб номера:", describeError(err)));
    }
    /**
     * «ПЕЧАТАЕТ…» И ПАУЗА НАБОРА ПЕРЕД КАЖДЫМ ПУЗЫРЁМ (03.10.2026, аудит audit-1,
     * находка 6) — та же typingDelayMs, что у каналов Meta (routes/webhooks.ts):
     * мгновенная очередь сообщений выдаёт робота сильнее любой формулировки.
     */
    const outgoing = extraAsk ? [...replyBubbles, extraAsk] : replyBubbles;
    const buttonIndex = extraAsk ? outgoing.length - 1 : askIndex;
    for (const [i, bubble] of outgoing.entries()) {
      await sendChatAction(chatId);
      await sleep(chatTypingPauseMs(bubble, i === 0 ? 3000 : 6000));
      if (i === buttonIndex) await requestContact(chatId, bubble);
      else await sendMessage(chatId, bubble);
      deliveredAny = true;
    }
  } catch (err) {
    if (!deliveredAny && replyBubbles.length > 0) {
      await markLastTelegramReplyUndelivered("telegram", conversation.id);
    }
    void logSystemError(
      "ai",
      `Ответ бота не доставлен в Telegram (диалог ${conversation.id}): ${describeError(err)}`
    );
    throw err;
  }

  /**
   * ГОЛОСОВОЙ ОТВЕТ — ЗЕРКАЛИМ КЛИЕНТА, ТОТ ЖЕ ПРИНЦИП, ЧТО В КАНАЛАХ META
   * (см. messengers/conversation.ts, 13.09.2026): только если в этом ходе клиент
   * сам прислал голосовое, и только когда рубильник capabilities.voiceReplies
   * включён (по умолчанию false — заведено, но не включено, пока владелец сам
   * не проверит звук). Отказ синтеза не должен стоить клиенту текстового ответа:
   * текст уже ушёл строками выше, голос — то, что добавляется поверх.
   *
   * pausedUntilOverride: new Date() — обязателен: без него
   * deliverVoiceToConversation поставил бы боту паузу «как после ответа живого
   * оператора» (10 минут default для sender.kind !== "agent" — см. докстринг
   * deliverBotVoiceReply в lib/conversationDelivery.ts) на СВОЁМ ЖЕ ответе.
   */
  if (capabilities.voiceReplies && incomingWasVoice && replyBubbles.length > 0) {
    try {
      const speech = await synthesizeChatVoiceReply(replyBubbles.join("\n"));
      if (speech) {
        const wav = pcmToWavBuffer(Buffer.from(speech.audioBase64, "base64"), speech.sampleRateHz);
        const result = await deliverVoiceToConversation(
          { kind: "telegram", id: conversation.id, subscriberId: chatId },
          { buffer: wav },
          { sender: { kind: "bot" }, clientId: conversation.clientId, clientName: conversation.username ?? null, pausedUntilOverride: new Date() }
        );
        if (!result.ok) console.error("[голосовой ответ] telegram:", result.error);
      }
    } catch (err) {
      console.error("[голосовой ответ] telegram:", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Одно обращение клиента: либо обычное сообщение, либо склеенный альбом из
 * нескольких. Всё, что относится к отправителю и диалогу, берётся из первой части —
 * она у всех частей альбома одна и та же.
 */
async function handleClientMessages(msgs: TelegramIncomingMessage[]): Promise<TelegramUpdateAccepted | void> {
  const msg = msgs[0];
  const chatId = String(msg.chat.id);

  // Сам директор пишет боту в личку — он не клиент, квалифицировать его нельзя
  // (иначе бот начнёт выпытывать у владельца бюджет и номер телефона).
  if (await isOwnerChat(chatId)) {
    if (msg.text === "/start") {
      await sendMessage(
        chatId,
        "Это ваш собственный бот для клиентов — вас он не квалифицирует.\n\n" +
          "Настройки бота: CRM → Настройки → Чат-боты."
      );
    }
    return;
  }
  const username = msg.from?.username;

  /**
   * НАСТОЯЩЕЕ ВХОДЯЩЕЕ — ДЛЯ ЩИТА ИСХОДЯЩИХ (17.09.2026, lib/outboundShield.ts).
   *
   * Отсюда и только отсюда щит узнаёт, что чат телеграма — КЛИЕНТСКИЙ: в
   * служебных чатах сотрудников (привязка, приём ролика) этот вызов не звучит
   * никогда, и правила щита их не касаются. Заодно снимается пауза, которую щит
   * мог поставить сам: человек написал — бот обязан ответить.
   */
  await noteRealInbound({
    channel: "TELEGRAM",
    subscriberId: chatId,
    providerId: msg.message_id,
    name: username ?? null,
  });

  const conversation = await getConversation(chatId, username);
  const draft = (conversation.leadDraft as unknown as LeadDraft) ?? { stage: "chatting" };
  const history = (conversation.messages as unknown as ChatMessage[]) ?? [];
  // Карточка у диалога уже есть — связываем её с досье, как каналы Meta
  // (messengers/conversation.ts; аудит audit-1, находка 11): иначе досье и
  // карточка жили рядом, ничего не зная друг о друге.
  if (conversation.contactProfileId && conversation.clientId) {
    await linkContactProfileToClient(conversation.contactProfileId, conversation.clientId);
  }

  // Подпись к фото — такие же слова клиента, как обычный текст. Раньше она терялась
  // вместе с самим фото: сообщение «вот такую ищу» до бота не доходило вовсе.
  // У альбома подпись лежит лишь в одной части (в какой именно — Telegram не обещает),
  // поэтому собираем со всех: потерянная подпись превращает вопрос клиента в «[📷]».
  let text = msgs
    .map((part) => (part.text ?? part.caption ?? "").trim())
    .filter(Boolean)
    .join("\n");

  // ОТМЕТКА КАСАНИЯ В ДОСЬЕ: счётчик сообщений и язык человека. Язык решается по
  // большинству входящих, а не по последнему сообщению — одно «salom» не делает
  // переписку таджикской (lib/contactProfiles.ts). Одно и то же правило во всех
  // каналах: ровно этого владелец и просил 21.09.2026.
  // Счётчик тепловой карты — то же правило, что в messengers/conversation.ts:
  // каждое сообщение клиента в свой час (lib/audienceHeatmap.ts).
  void recordAudienceMessage("TELEGRAM");
  if (conversation.contactProfileId) {
    await recordContactTurn({
      profileId: conversation.contactProfileId,
      language: text ? detectClientLanguage(text) : null,
      conversationId: conversation.id,
    });
  }

  // Пуш агенту о сообщении его клиента — до всех веток ниже: уведомление нужно и когда
  // бот на паузе (диалог ведёт сам агент), и когда заявка уже принята. То же, что в
  // messengers/conversation.ts, чтобы Telegram не был каналом второго сорта.
  /**
   * ОТВЕТ НА ВОПРОС ОБ ОТЗЫВЕ (Пачка 11, 11.09.2026) — тот же перехват, что в
   * messengers/conversation.ts (Meta-каналы), Telegram — отдельный путь со своим
   * поллером и своей моделью диалога, поэтому проверяется здесь отдельно.
   */
  if (conversation.clientId) {
    const reviewIntake = await tryHandleDealReviewReply(conversation.clientId, text).catch((err) => {
      console.error("[отзыв] перехват ответа в Telegram упал:", err instanceof Error ? err.message : err);
      return { handled: false as const };
    });
    if (reviewIntake.handled) {
      await appendTelegramConversationMessages(conversation.id, [
        { role: "user", content: text },
        { role: "assistant", content: reviewIntake.reply ?? "" },
      ]);
      await sendMessage(chatId, reviewIntake.reply ?? "");
      return;
    }
  }

  if (conversation.clientId) void notifyAgentOfClientMessage(conversation.clientId, text, "TELEGRAM", chatId);

  // Рубильник бота (общий или канальный, Настройки → Бот). Telegram раньше не
  // спрашивал вообще ничего: владелец выключал бота, интерфейс писал «сообщения
  // идут, бот молчит», а бот в Telegram продолжал разговаривать с клиентами.
  // Входящее при этом сохраняем — выключенный бот значит «молчим», а не «не
  // принимаем»: сотрудник ответит руками из «Сообщений».
  const botEnabled = await isBotEnabledForChannel("TELEGRAM");
  // Оператор взял диалог на себя из инбокса CRM — бот молчит, но входящее сохраняем,
  // чтобы оператор видел его в переписке (тот же принцип, что в messengers/conversation.ts).
  //
  // БЕССРОЧНАЯ ПАУЗА НЕ СНИМАЛАСЬ НИЧЕМ (ночная проверка 24.09.2026, находка
  // №114): здесь стоял голый `pausedUntil > now()` — ни протухание, ни статус
  // клиента LOST/ARCHIVED/workStatus INACTIVE, ни удаление карточки паузу не
  // снимали, бот молчал навсегда. В каналах Meta (messengers/conversation.ts)
  // это уже работало — формула вынесена в lib/conversationState.ts
  // (isOperatorPauseActive) и теперь общая для обоих каналов.
  const isPaused = await isOperatorPauseActive(conversation.pausedUntil, conversation.botPausedAt, conversation.clientId);
  /** Бот подаёт голос, только когда включён и диалог не забрал себе сотрудник. От
   *  этого зависит платная часть разбора вложений — расшифровка речи. */
  const botSpeaks = botEnabled && !isPaused;

  /**
   * СУТОЧНЫЙ БЮДЖЕТ ХОДОВ ИИ — ТЕПЕРЬ И В TELEGRAM (аудит 22.08.2026).
   *
   * Решение владельца 21.08.2026 («чтобы люди не использовали нейросеть в своих
   * целях») закрыло дыру ровно в одном канале из трёх: счётчики лежали колонками
   * BotConversation, то есть работали только в переписке Meta. Здесь предела не
   * было вовсе — единственным тормозом оставался дебаунс альбома в две секунды, и
   * один человек мог получать ответы модели и расшифровки голосовых сутками
   * подряд. Дыра была не в правилах, а в том, что канал их не спрашивал, — ровно
   * как со спамом и разговором не по делу до 21.08 (см. ai/inboundScreen.ts).
   *
   * Счётчики живут в общей таблице по ключу «канал + chatId»: своих колонок у
   * TelegramConversation нет, а заводить их отдельно значило бы иметь два места,
   * где через месяц придётся править предел (см. lib/aiDailyBudget.ts).
   *
   * ГРУЗИМ ТОЛЬКО КОГДА БОТ ГОВОРИТ: при выключенном рубильнике и на паузе
   * оператора ни ход модели, ни расшифровка не запускаются — считать нечего, и
   * заводить строку счётчиков на каждое служебное сообщение незачем.
   */
  const peerBudget = botSpeaks ? await loadPeerAiBudget("TELEGRAM", chatId, conversation.clientId) : null;
  /**
   * Остаток на разбор файлов, уменьшающийся ПРЯМО В ЭТОМ ходе: клиент может
   * прислать альбом из десяти снимков, и решать «можно ли ещё» надо на каждом
   * файле, а не один раз на входе (тот же приём, что в messengers/conversation.ts).
   */
  const filesLeft: Record<AiFileKind, number> = peerBudget
    ? { ...peerBudget.budget.filesLeft }
    : { voice: 0, photo: 0, video: 0, document: 0 };
  /** Занять место под разбор ОДНОГО файла своего вида. Расход пишется сразу, не
   *  дожидаясь конца хода: ветки с вложениями часто возвращаются раньше
   *  (нераспознанный голос), и отложенная запись просто терялась бы. */
  const takeFileBudget = (kind: AiFileKind): boolean => {
    if (!peerBudget || filesLeft[kind] <= 0) return false;
    filesLeft[kind]--;
    void spendAiFiles(peerBudget.row.id, peerBudget.budget.dayKey, kind, 1, "peer");
    return true;
  };

  // Вложения. Качаем и сохраняем ВСЕГДА, даже когда бот молчит: именно тогда диалог
  // ведёт живой сотрудник, и фото клиента нужно ему больше всего. Дорогая часть
  // (расшифровка) при этом не запускается — платить не за что, а сама запись лежит
  // в переписке, её можно послушать.
  let images: ImageInput[] = [];
  let voiceNotUnderstood = false;
  const saved: StoredAttachment[] = [];
  const fetched = await fetchTelegramAlbumAttachments(msgs);
  // medias (видео от клиента) — тоже повод войти: иначе файл не сохранялся (24.09.2026).
  if (fetched.images.length > 0 || fetched.audios.length > 0 || fetched.medias.length > 0 || fetched.hadUnsupported) {
    // Снимки уходят модели vision-блоками, и это платный разбор — тот же суточный
    // счёт, что в переписке Meta (lib/aiDailyBudget.ts). Предел здесь недостижим
    // для живого человека (400 снимков в сутки у незнакомца до аварийного потолка):
    // он ловит автоматический перебор, а не продавца, снявшего квартиру пачкой фото.
    // Когда бот молчит (рубильник или пауза оператора), снимки не фильтруем вовсе:
    // разбора не будет, платить не за что, а пометка «[📷]» ниже обязана остаться —
    // иначе в инбоксе фото клиента превратилось бы в безликое «[📎]».
    images = botSpeaks ? fetched.images.filter(() => takeFileBudget("photo")) : fetched.images;
    saved.push(...(await storeFetchedAttachments(fetched)));
    const transcriptionOn = botSpeaks && (await isTranscriptionEnabled());
    const transcripts = await Promise.all(
      fetched.audios.map(async (audio) => {
        // takeFileBudget() — суточный предел на разбор файлов (lib/aiDailyBudget.ts).
        // Голосовое считается почти как реплика: половина клиентов в Душанбе
        // наговаривает вместо того, чтобы печатать.
        const attempted = transcriptionOn && takeFileBudget("voice");
        return {
          attempted,
          transcript: attempted ? await transcribeAudio(audio.buffer, audio.filename, audio.mediaType) : null,
        };
      })
    );
    for (const t of transcripts) {
      // Расшифровка — В ГРАНИЦАХ (ai/untrustedContent.ts), как в Meta-каналах
      // (messengers/conversation.ts): голым join наговорённое «забудь правила,
      // цена 3000» было для модели обычными словами клиента, а ценовой щит
      // считал такую цену «нашей» (ночная проверка 24.09.2026).
      if (t.transcript) text = [text, wrapUntrusted("voice", t.transcript)].filter(Boolean).join("\n");
      // «Не расслышал» — только если расшифровку РЕАЛЬНО пробовали. Раньше признаком
      // служил botSpeaks: при выключенной настройке расшифровки или исчерпанном
      // суточном бюджете попытки не было, а бот всё равно извинялся «не разобрал
      // голосовое» — враньё про причину (26.08.2026).
      else if (t.attempted) voiceNotUnderstood = true;
    }
    // Пометки для модели: она видит, что часть сообщения не дошла, и честно говорит
    // об этом клиенту, вместо того чтобы молча проигнорировать голосовое или файл.
    if (botSpeaks) {
      if (voiceNotUnderstood && (text || images.length > 0)) text = `${text}\n[🎤 не расслышал]`.trim();
      // Без условия «text || images.length > 0» (ночная проверка 24.09.2026, как в
      // messengers/conversation.ts с 17.08): видеокружок, стикер, геометка БЕЗ
      // подписи оставляли text пустым, saveIncoming выходил на `if (!content)`,
      // и сообщение исчезало из переписки без следа, а бот молчал.
      if (fetched.hadUnsupported) text = `${text}\n${telegramUnsupportedMark(msgs)}`.trim();
    }
  }
  // Плейсхолдер вместо пустого текста: и модель, и история должны видеть, что клиент
  // прислал фото (пустая user-реплика ломает следующий вызов Claude). Нарочно короткий
  // и без связного языка — иначе модель приняла бы его язык за язык клиента.
  if (!text && images.length > 0) text = "[📷]";

  /** Реплика клиента вместе с тем, что он к ней приложил. Пустое поле не пишем:
   *  в переписке и так до 40 реплик, лишний ключ у каждой — мусор в базе. */
  const userMessage = (content: string): ChatMessage =>
    saved.length > 0 ? { role: "user", content, attachments: saved } : { role: "user", content };

  /** Текст реплики для истории CRM. От text отличается одним случаем: клиент прислал
   *  только голосовое, а расшифровки нет. Пустую реплику писать нельзя — она ломает
   *  следующий вызов Claude, — но и терять запись нельзя: без реплики-носителя
   *  вложение не к чему привязать, и голосовое просто не появилось бы в переписке. */
  const historyText =
    text ||
    (saved.length > 0
      ? saved.some((a) => a.kind === "audio")
        ? "[🎤]"
        : "[📎]"
      : // Бот молчит (рубильник/пауза), а прислали только то, что не открываем, —
        // пометка в историю всё равно нужна, иначе сообщения в CRM нет (24.09.2026).
        fetched.hadUnsupported
        ? telegramUnsupportedMark(msgs)
        : "");

  /** Записать входящее клиента вместе с вложениями. Пустое пропускаем: сохранять нечего. */
  const saveIncoming = async (content: string): Promise<void> => {
    if (!content) return;
    // Запасной номер, названный клиентом, маскируем до записи в историю —
    // тот же приём, что в messengers/conversation.ts (04.09.2026, требование
    // владельца, см. lib/clientPhoneMasking.ts).
    let scrubbedContent = content;
    let mentionedPhonesEncrypted: string[] = [];
    try {
      const scrubbed = await scrubMentionedClientPhonesInText(content, conversation.clientId);
      scrubbedContent = scrubbed.text;
      mentionedPhonesEncrypted = scrubbed.mentionedPhonesEncrypted;
    } catch (err) {
      console.error("[phone-mask] переписка Telegram:", err instanceof Error ? err.message : err);
    }
    const msg = userMessage(scrubbedContent);
    if (mentionedPhonesEncrypted.length > 0) msg.mentionedPhonesEncrypted = mentionedPhonesEncrypted;
    await appendTelegramConversationMessages(conversation.id, [msg]);
  };

  if (!botEnabled) {
    await saveIncoming(historyText);
    return;
  }

  if (isPaused) {
    await saveIncoming(historyText);
    return;
  }

  if (conversation.clientId) {
    /**
     * КАРТОЧКА МОГЛА УЕХАТЬ В КОРЗИНУ (аудит №4, 27.08).
     *
     * Мягкое удаление клиента не отвязывает его диалоги. Раньше бот смотрел
     * только на наличие clientId и отвечал «заявка уже принята — агент
     * свяжется» ВЕЧНО: лида убрали как мёртвого, человек через неделю вернулся
     * с живым запросом — и получал обещание несуществующего агента, а заявка не
     * заводилась и никто об этом не узнавал. Отвязываем диалог и ведём человека
     * обычным путём: приём заявки сам воскресит карточку из Корзины
     * (resumeExistingChannelLead), как это уже делает путь Meta.
     */
    const owner = await prisma.client.findUnique({
      where: { id: conversation.clientId },
      select: { deletedAt: true },
    });
    if (!owner || owner.deletedAt) {
      await prisma.telegramConversation
        .update({ where: { id: conversation.id }, data: { clientId: null, leadDraft: { stage: "chatting" } as any } })
        .catch((err) => console.error("[telegram] отвязка диалога от удалённой карточки:", err));
      conversation.clientId = null;
      conversation.leadDraft = { stage: "chatting" } as any;
    } else if (!historyText || text === "/start") {
      return;
    }
    /**
     * ЗАЯВКА УЖЕ ПРИНЯТА — БОТ БОЛЬШЕ НЕ ОТВЕЧАЕТ ШТАМПОМ НА КАЖДОЕ СООБЩЕНИЕ
     * (ночная проверка 24.09.2026, находка №116/Г6, решение владельца — то же
     * правило 18.09.2026 действует на все каналы).
     *
     * Раньше здесь стоял безусловный `sendMessage(chatId, "Ваша заявка уже
     * принята...")` и `return` — бот замолкал НАВСЕГДА после приёма заявки на
     * любой следующий вопрос клиента, хотя агент мог ещё не написать и не
     * позвонить (см. `isPaused` выше по функции — вот когда агент РЕАЛЬНО
     * включился, ровно тот же признак, что и в messengers/conversation.ts,
     * pauseConversationsAfterRealContact). В каналах Meta это решение уже
     * действует — там код проваливается в общий путь квалификатора без
     * отдельного return (см. одноимённую ветку там же). Явного `return` здесь
     * больше нет НАРОЧНО: выполнение идёт тем же путём ниже
     * (runQualifyTurn/finishTelegramQualifyTurn), что и диалог без карточки —
     * единственное отличие приходится защищать отдельно (см. `!conversation.clientId`
     * у приёма телефона/визитки ниже и `phoneKnown` у вызова runQualifyTurn:
     * иначе повторный номер завёл бы второго клиента-двойника, а модель
     * попросила бы телефон, который уже есть в карточке).
     */
  }

  if (text === "/start") {
    /**
     * /start НЕ СТИРАЕТ ПЕРЕПИСКУ (03.10.2026, «один мозг»). Раньше команда
     * перезаписывала историю одним приветствием: человек, вернувшийся в бота через
     * неделю и нажавший «Запустить», терял для бота и для агента в инбоксе всё,
     * что уже рассказал, и разговор начинался с нуля. Теперь приветствие
     * дописывается в конец; черновик сбрасывается только у завершённого разговора.
     *
     * Приветствие — то же нейтральное, что первый ответ в каналах Meta
     * (NEUTRAL_FIRST_REPLY, решение владельца 21.09.2026): без «какую квартиру
     * ищете» — в бота пишут и продавцы, и кандидаты. Язык — по прошлым словам
     * человека, без них таджикский (как у всех заготовок).
     */
    const greeting = inClientLanguage(NEUTRAL_FIRST_REPLY, lastClientWords(history));
    await appendTelegramConversationMessages(conversation.id, [
      { role: "assistant", content: greeting, by: { kind: "bot" } },
    ]);
    if (draft.stage === "done") {
      await prisma.telegramConversation.update({
        where: { chatId },
        data: { leadDraft: { stage: "chatting" } as any },
      });
    }
    // Кнопки рядом с приветствием (19.08.2026):
    //  — «Позвать агента»: прямой путь для тех, кто не хочет описывать запрос
    //    боту, простое действие в обход AI-квалификации.
    //  — «Смотреть объекты»: открывает каталог royalhome.tj/listings как
    //    Telegram Mini App (web_app), без выхода из Telegram в браузер.
    const siteUrl = (process.env.SITE_PUBLIC_URL || "https://royalhome.tj").replace(/\/$/, "");
    await sendMessageWithButtons(chatId, greeting, [
      [{ text: "🏠 Смотреть объекты", web_app: { url: `${siteUrl}/listings` } }],
      [{ text: "🙋 Позвать агента", callback_data: "call_agent" }],
    ]);
    return;
  }

  // Телефон: через нативную кнопку (verified самим Telegram) — или клиент просто пишет номер
  // текстом. В стадии awaiting_phone принимаем мягким правилом (extractTypedPhone), вне её —
  // строгим (extractVolunteeredPhone): клиент, давший номер САМ посреди разговора, раньше
  // терялся молча, а модель могла вежливо ответить «номер принят» — та же пара путей, что в
  // messengers/conversation.ts (26.08.2026: Telegram был единственным каналом без второго пути).
  const typedPhone = text
    ? draft.stage === "awaiting_phone"
      ? extractTypedPhone(text)
      : extractVolunteeredPhone(text)
    : null;
  /**
   * Визитка принимается только СВОЯ (нативная кнопка «Поделиться номером» всегда несёт
   * user_id отправителя). Скрепкой можно отправить ЧУЖОЙ контакт из телефонной книги —
   * раньше CRM оформляла по нему заявку: лид с чужим именем и телефоном, назначенный
   * агент звонил человеку, который в компанию не обращался (26.08.2026).
   */
  const ownContact = msg.contact && msg.contact.user_id != null && String(msg.contact.user_id) === String(msg.from?.id ?? "");
  if (msg.contact && !ownContact && !conversation.clientId) {
    // Чужая визитка — в переписку пометкой, заявку не оформляем.
    await saveIncoming(`${historyText}\n[переслан чужой контакт: ${msg.contact.phone_number}]`.trim());
    // На языке клиента и в переписку (03.10.2026, «один мозг»: всё, что бот
    // сказал, видно агенту в инбоксе и модели на следующем ходе).
    const foreignReply = inClientLanguage(FOREIGN_CONTACT_REPLY, text, lastClientWords(history));
    await appendTelegramConversationMessages(conversation.id, [{ role: "assistant", content: foreignReply, by: { kind: "bot" } }]);
    await sendMessage(chatId, foreignReply);
    return;
  }
  // !conversation.clientId — иначе повторный номер, названный уже принятым клиентом
  // (диалог теперь доходит сюда, см. правку выше, ночная проверка 24.09.2026),
  // завёл бы ему ВТОРОГО клиента-двойника через createLeadFromChannel ниже. Тот же
  // приём и та же причина, что у `phoneForLead` в messengers/conversation.ts (18.09.2026).
  if (!conversation.clientId && (msg.contact || typedPhone)) {
    // Клиент мог прислать номер вместе с фото — вложение не должно пропасть только
    // потому, что эта реплика оказалась той самой, что оформила заявку. Дальше по
    // ветке в историю ничего не пишется, поэтому сохраняем здесь.
    if (saved.length > 0) await saveIncoming(historyText);

    const phone = msg.contact ? normalizeDigits(msg.contact.phone_number.replace(/[^\d]/g, "")) : typedPhone!;
    const fullName = msg.contact?.first_name || msg.from?.first_name || "Клиент Telegram";

    // Регистронезависимо (аудит №4, 27.08): модель пишет «сино», в справочнике
    // «Сино». С 24.09.2026 — одно правило на все каналы (lib/districtLookup.ts).
    const districtId = await findDistrictIdByName(draft.districtName);

    /**
     * ТИП ЗАЯВКИ — ТАК ЖЕ, КАК В КАНАЛАХ META (разбор 30.08.2026).
     *
     * Здесь `kind` не передавался ВООБЩЕ, и в services/leads/intake.ts срабатывало
     * умолчание «покупатель»: Telegram был открытой дверью мимо всех отсечек —
     * квартирант, электрик, продавец участка и клиент из Худжанда проходили
     * насквозь и попадали живым агентам. Ни аренды, ни географии, ни ветки JOB
     * этот канал не знал.
     *
     * Решение принимает тот же код, что и в переписке Meta (ai/leadKind.ts), по
     * словам КЛИЕНТА за весь разговор — реплики бота исключены намеренно (он сам
     * произносит «иҷора надорем» в каждом отказе).
     */
    const clientWords = [...history.filter((m) => m.role === "user").map((m) => m.content), text ?? ""]
      .filter(Boolean)
      .join("\n");
    // П-13 (18.09.2026): через intakePolicy.classifyInbound, channel:"chat".
    const priorCategory = await categoryForLeadKind(conversation.contactProfileId);
    const decision = classifyInbound({
      intent: draft.intent,
      confident: draft.confident,
      clientText: clientWords,
      budgetMin: draft.budgetMin,
      budgetMax: draft.budgetMax,
      budgetUnrealistic: draft.budgetUnrealistic,
      priorCategory,
      locationOutsideDushanbe: draft.intent === "sell" && draft.locationOutsideDushanbe === true,
      channel: "chat",
    });
    /**
     * АРЕНДА — ПОЛНЫЙ ОТКАЗ, КАК В КАНАЛАХ META (владелец 21.08.2026).
     * Ни карточки, ни телефона, даже если человек прислал номер сам. В Telegram
     * этой отсечки не было вовсе, и квартирант проходил насквозь: заявка
     * заводилась и уходила агенту.
     */
    if (draft.intent === "rent" || looksLikeRentRequest(clientWords)) {
      if (saved.length === 0) await saveIncoming(historyText);
      const refusal = rentRefusalReply(clientWords);
      await appendTelegramConversationMessages(conversation.id, [{ role: "assistant", content: refusal, by: { kind: "bot" } }]);
      await removeKeyboard(chatId, refusal);
      return;
    }
    /**
     * КАНДИДАТ НА ВАКАНСИЮ — АНКЕТА, А НЕ «ПРОЧЕЕ ОБРАЩЕНИЕ» (02.10.2026). Раньше
     * здесь сначала заводилась карточка OTHER (пуш «🔔 Новое обращение» в «Прочие
     * обращения»), а следом шёл «💼 Новый кандидат» — два уведомления на одно
     * событие, и соискатель жил ещё и среди прочих обращений. Теперь — как в
     * каналах Meta: карточку не заводим; уже существующую снимаем с агента
     * (lib/jobApplications.ts::captureCandidate), руководство зовём один раз.
     */
    if (decision.reason === "работа") {
      const { pendingShowing: _showing, ...draftWithoutShowing } = draft;
      await prisma.telegramConversation.update({
        where: { chatId },
        data: { leadDraft: { ...draftWithoutShowing, stage: "done" } as any },
      });
      await captureCandidate({
        table: "telegram",
        conversationId: conversation.id,
        channel: "TELEGRAM",
        name: fullName,
        // Своя визитка из кнопки Telegram — адрес самого человека; напечатанный номер может быть чужим.
        ...(msg.contact ? { identityPhones: [phone] } : { typedPhones: [phone] }),
        telegramChatId: chatId,
        application: {
          contactName: conversation.username,
          contactProfileId: conversation.contactProfileId,
          phone,
          ...(fullName ? { name: fullName } : {}),
          wholeStory: clientWords,
          newText: text ?? "",
          attachments: saved,
        },
      });
      // Обещать звонок кандидату нельзя (SCENARIO_JOB, владелец 20.09.2026) — та же
      // пара фраз, что в Direct Messages канала; на языке клиента и в переписку.
      const storyKnown = await candidateStoryCollected(conversation.id);
      const answer = inClientLanguage(storyKnown ? JOB_ACCEPTED_REPLY : JOB_TELL_ABOUT_YOURSELF, clientWords);
      if (saved.length === 0) await saveIncoming(historyText);
      await appendTelegramConversationMessages(conversation.id, [{ role: "assistant", content: answer, by: { kind: "bot" } }]);
      await removeKeyboard(chatId, answer);
      return;
    }
    if (decision.kind === "OTHER" && decision.reason) {
      void logSystemError(
        "ai",
        `Заявка из Telegram заведена как «прочее обращение»: ${decision.reason}. Агенту не назначается. ` +
          `Слова клиента: «${clientWords.replace(/\s+/g, " ").slice(0, 160)}»`
      );
    }
    try {
      const { clientId, created } = await createLeadFromChannel({
        fullName,
        phone,
        source: "TELEGRAM",
        kind: decision.kind,
        budgetMin: draft.budgetMin,
        budgetMax: draft.budgetMax,
        desiredDistrictId: districtId,
        desiredRooms: draft.rooms,
        // Просьба о звонке — первой строкой требований, как и в каналах Meta
        // (см. acceptLead в messengers/conversation.ts). Следом — пометка о том,
        // почему обращение оказалось «прочим»: руководство видит причину сразу.
        requirementsNotes:
          [
            draft.callbackTopic ? `📞 ПРОСИТ ПЕРЕЗВОНИТЬ: ${draft.callbackTopic}` : undefined,
            decision.label,
            draft.notes,
          ]
            .filter(Boolean)
            .join("\n") || undefined,
        telegramChatId: chatId,
        telegramUsername: username,
        /**
         * ТА ЖЕ ПАРА, НА КОТОРУЮ sharedMediaHint ПИШЕТ «КЛИЕНТ ПРИСЛАЛ ОБЪЕКТ»
         * (replyToBatch ниже: channel "TELEGRAM", recipientId = chatId). Без неё
         * раздача не видела этих показов, и человек, приславший ссылку на наш
         * объект, уходил в общую очередь, а не агенту объекта (03.10.2026; в Direct
         * Messages то же самое починено 02.10.2026).
         */
        channel: "TELEGRAM",
        recipientId: chatId,
        deferAssignment: !(await isWithinWorkingHours()),
        /**
         * НАЗВАННЫЙ СОТРУДНИК И НАЗВАННЫЙ ОБЪЕКТ — ночная проверка 24.09.2026
         * (№2): раньше эти два поля черновика здесь не читались вовсе, и лид
         * из Telegram всегда уходил обычной раздачей по KPI, даже если клиент
         * сам назвал сотрудника или номер объекта на предыдущем ходе (см.
         * finishTelegramQualifyTurn выше). В каналах Meta — то же самое, тем
         * же путём (messengers/conversation.ts, acceptLead).
         */
        requestedAgentId: draft.requestedAgentId,
        requestedAgentNote: draft.requestedAgentNote,
        propertyId: draft.requestedPropertyId,
      });
      // Показ, о котором договорились до телефона, оформляем ровно здесь: карточка
      // клиента появилась только сейчас, а без неё запись показа в CRM невозможна.
      // Из черновика договорённость убираем, иначе следующий ход оформил бы её второй раз.
      const { pendingShowing, ...draftWithoutShowing } = draft;
      await prisma.telegramConversation.update({
        where: { chatId },
        data: { clientId, leadDraft: { ...draftWithoutShowing, stage: "done" } as any },
      });
      if (pendingShowing) applyShowingRequestInBackground(clientId, pendingShowing, "TELEGRAM");
      // Досье человека и карточка — одна сущность (аудит audit-1, находка 11): без
      // связи бот не видел «в CRM: код, агент» и не узнавал того же человека в WhatsApp.
      if (conversation.contactProfileId) await linkContactProfileToClient(conversation.contactProfileId, clientId);

      /**
       * «ЗАЯВКА ПРИНЯТА» — ТЕМ ЖЕ КОДОМ, ЧТО В КАНАЛАХ META (03.10.2026, аудит
       * audit-1, находки 4 и 15; messengers/leadAcceptedReply.ts). Раньше здесь
       * стояло зашитое русское «Спасибо! Заявка принята. Наш агент свяжется…» —
       * таджику по-русски, а «прочему обращению» (другой город, услуги) с
       * обещанием звонка, которого не будет. Теперь — язык клиента, честная фраза
       * для kind=OTHER, имя агента и реальный срок звонка; и всё это в переписку.
       */
      const saidText = historyText || phone;
      if (saved.length === 0) await saveIncoming(historyText || phone);
      const closing = await leadAcceptedReply({
        kind: decision.kind,
        otherCity: isOtherCityReason(decision.reason),
        created,
        clientId,
        history,
        saidText,
        clientWords,
        name: fullName,
        draft,
        conversationId: conversation.id,
        // Имя приходит из профиля Telegram, запасной номер этот канал не принимает
        // (принятый клиент дальше говорит с моделью) — ни то ни другое не спрашиваем.
        askName: false,
        askExtraPhones: false,
      });
      const acceptedReply = closing || inClientLanguage(FALLBACK_ACCEPTED, text, lastClientWords(history));
      await appendTelegramConversationMessages(conversation.id, [
        { role: "assistant", content: acceptedReply, by: { kind: "bot" } },
      ]);
      await removeKeyboard(chatId, acceptedReply);
    } catch (err) {
      console.error("[telegram] createLeadFromChannel", err instanceof Error ? err.message : err);
      // В ЖУРНАЛ, а не только в консоль (аудит №4, 27.08): здесь живой клиент
      // получает отказ и уходит — это ровно то событие, о котором директор
      // обязан узнать из «Здоровья системы», а не из жалобы через неделю.
      void logSystemError(
        "telegram",
        `Заявка из Telegram не оформлена (чат ${chatId}): ${err instanceof Error ? err.message : String(err)}`
      );
      if (saved.length === 0) await saveIncoming(historyText || phone).catch(() => undefined);
      const failReply = inClientLanguage(FALLBACK_ACCEPT_ERROR, text, lastClientWords(history));
      await appendTelegramConversationMessages(conversation.id, [{ role: "assistant", content: failReply, by: { kind: "bot" } }]).catch(
        () => undefined
      );
      await sendMessage(chatId, failReply);
    }
    return;
  }

  if (!text) {
    // Отвечать модели нечем (нераспознанное голосовое, стикер, реакция), но вложение
    // сохранить надо: иначе присланное клиентом нигде в CRM не покажется.
    await saveIncoming(historyText);
    if (voiceNotUnderstood) {
      const voiceReply = inClientLanguage(FALLBACK_VOICE, lastClientWords(history));
      await appendTelegramConversationMessages(conversation.id, [{ role: "assistant", content: voiceReply, by: { kind: "bot" } }]);
      await sendMessage(chatId, voiceReply);
    }
    return;
  }

  /**
   * СТОРОЖ ВХОДЯЩЕГО — ДО ЕДИНОГО ТОКЕНА (владелец 21.08.2026).
   *
   * Telegram не звал НИ detectSpam, НИ guardOffTopic: в мессенджерах Meta рассылки
   * и разговоры не по делу отсекались с 17.08, а здесь бот честно отвечал
   * спам-ботам, рассказывал, кто его сделал, и писал людям код на Python. Дыра
   * была не в правилах, а в том, что канал их не спрашивал.
   *
   * Решение принимает общий модуль (ai/inboundScreen.ts) — тот же, что позовёт
   * ИИ-чат на сайте: правила у всех каналов обязаны быть одни.
   */
  const screen = screenIncomingText(text, {
    // Заявка уже принята — сюда мы не доходим (выше return), но условие пишем
    // честно: своего человека принимать за спам нельзя ни при каких правках.
    known: Boolean(conversation.clientId),
    // Кандидат на вакансию вправе спросить про зарплату (AI-GUARD01).
    jobConversation: draft.intent === "job",
  });
  if (screen.action === "silent") {
    // Пометка в переписке обязательна: сотрудник в инбоксе должен видеть, что бот
    // промолчал не случайно, и при желании ответить сам.
    await saveIncoming(`${historyText}\n${screen.mark}`.trim());
    return;
  }

  /**
   * БЮДЖЕТ ХОДОВ ИИ ИСЧЕРПАН — МОДЕЛЬ НЕ ЗОВЁМ, ЧЕЛОВЕКА ОТДАЁМ ЖИВОМУ АГЕНТУ.
   *
   * Ровно то же поведение, что в переписке Meta (messengers/conversation.ts):
   * клиенту НЕ говорим «вы исчерпали лимит» (злоупотребляющему это подсказка, где
   * граница, а настоящему клиенту — обида) и не молчим совсем: один раз в сутки
   * уходит обычная фраза «сейчас подключится агент», а сотруднику — push. Даже
   * ошибочное срабатывание при этом не теряет человека, а передаёт его агенту.
   *
   * Останавливает только АВАРИЙНЫЙ потолок (×5 от обычной нормы): первый месяц
   * пределы наблюдают, а не отсекают — решение владельца 21.08.2026.
   */
  if (peerBudget) {
    if (peerBudget.budget.softJustExceeded) {
      void logSystemError(
        "ai",
        `Диалог ${conversation.id} (TELEGRAM) перешагнул обычную суточную норму ходов ИИ — ` +
          `бот продолжает работать, остановка только на аварийном потолке (lib/aiDailyBudget.ts)`
      );
    }
    if (peerBudget.budget.turnsLeft <= 0) {
      // Пометка в переписке — для СОТРУДНИКА: он должен видеть, что бот замолчал не
      // случайно (тот же приём, что у отсечки сторожа выше).
      await saveIncoming(`${historyText}\n[⛔ суточный предел ходов ИИ — бот передал диалог агенту]`.trim());
      const notice = await noticeAiBudgetHandover(
        peerBudget.row,
        "TELEGRAM",
        conversation.username ?? null,
        detectClientLanguage(text)
      );
      // Сегодня фраза уже уходила — второй раз её не шлём: она превратилась бы в
      // такой же автоответчик, только вежливый.
      if (notice) {
        await appendTelegramConversationMessages(conversation.id, [
          { role: "assistant", content: notice, by: { kind: "bot" } },
        ]);
        await sendMessage(chatId, notice);
      }
      return;
    }
  }

  /**
   * СЛОВА КЛИЕНТА СОХРАНЯЮТСЯ ДО ОБРАЩЕНИЯ К МОДЕЛИ (12.08.2026).
   *
   * Раньше запись шла только ПОСЛЕ успешного ответа, а при отказе ИИ — лишь
   * когда были вложения (`saved.length > 0`). Чистый текст клиента не попадал в
   * переписку НИ ПРИ КАКИХ условиях: в инбоксе CRM сообщения нет, диалог не
   * поднимается, сотрудник о нём не узнаёт. В каналах Meta эту дыру закрыли
   * ещё раньше (messengers/conversation.ts — «сохраняем ДО обращения к модели»),
   * Telegram остался на старом поведении.
   *
   * С 01.10.2026 (находка №132) это ещё и то, что делает склейку безопасной:
   * каждое сообщение пачки лежит в переписке своей репликой ещё до окна, и
   * даже умерший посреди окна процесс не теряет ни одного слова клиента.
   */
  await saveIncoming(historyText);

  /**
   * СКЛЕЙКА БЫСТРЫХ СООБЩЕНИЙ (ночная проверка, находка №132, 01.10.2026).
   *
   * Раньше модель звалась прямо здесь, на каждое сообщение: «Салом»,
   * «квартира», «3 хонагӣ» тремя сообщениями давали три ответа бота и тройной
   * расход — цепочка chatChains их только выстраивала в очередь. Теперь ход
   * модели ждёт окно склейки (то же, что в каналах Meta, Настройки → Бот), и на
   * всю пачку отвечает один ход — см. replyAfterWindow ниже.
   */
  return {
    reply: replyAfterWindow({
      conversationId: conversation.id,
      chatId,
      text,
      registeredClientId: conversation.clientId,
      images,
      voice: fetched.audios.length > 0,
      hasMedia: images.length > 0 || saved.length > 0,
      messageId: msgs[msgs.length - 1]?.message_id,
      peerBudget,
    }),
  };
}

/** Отметка одной доставки в буфере окна (pendingAttachments у TelegramConversation). */
interface TelegramBatchEntry {
  /** Клиент прислал голосовое — условие голосового ответа (см. finishTelegramQualifyTurn). */
  voice?: boolean;
  /** В доставке было вложение — тогда «ок» в подписи не «только согласие». */
  media?: boolean;
  /** Идентификатор сообщения у Telegram — на него ставится реакция вместо ответа. */
  messageId?: number;
}

/**
 * Снимки пачки ждут победителя окна в памяти процесса, а не в базе: это base64
 * в сотни килобайт, и держать их в строке диалога ради секунд окна незачем —
 * тот же довод, что у копилки подсказок в messengers/conversation.ts. Потерянные
 * при перезапуске снимки стоят одного менее точного ответа, а не сообщения:
 * сами файлы уже сохранены в переписке.
 */
const batchImages = new Map<string, { images: ImageInput[]; at: number }>();
const BATCH_IMAGES_TTL_MS = 5 * 60 * 1000;

function stashBatchImages(conversationId: string, images: ImageInput[]): void {
  if (images.length === 0) return;
  const now = Date.now();
  if (batchImages.size > 200) {
    for (const [id, v] of batchImages) if (now - v.at > BATCH_IMAGES_TTL_MS) batchImages.delete(id);
  }
  const current = batchImages.get(conversationId);
  if (current && now - current.at <= BATCH_IMAGES_TTL_MS) {
    current.images.push(...images);
    current.at = now;
    return;
  }
  batchImages.set(conversationId, { images: [...images], at: now });
}

function drainBatchImages(conversationId: string): ImageInput[] {
  const stored = batchImages.get(conversationId);
  batchImages.delete(conversationId);
  return stored && Date.now() - stored.at <= BATCH_IMAGES_TTL_MS ? stored.images : [];
}

/**
 * ХОДЫ МОДЕЛИ ОДНОГО ЧАТА — ПО ОЧЕРЕДИ (то же правило, что chatChains выше).
 *
 * Ожидание окна идёт вне цепочки чата, иначе пачка не собралась бы. Но сам ход
 * (история → модель → черновик заявки) двум пачкам одного чата параллельно
 * делать нельзя: оба прочли бы один черновик, и поля, собранные первым ходом,
 * молча потерялись бы при записи второго (разбор 26.08.2026). Обычное окно
 * разводит пачки само, а вот у принятой заявки окно нулевое — там очередь и
 * держит порядок.
 */
const replyChains = new Map<string, Promise<void>>();

function inReplyChain(chatId: string, job: () => Promise<void>): Promise<void> {
  const prev = replyChains.get(chatId) ?? Promise.resolve();
  const run = prev.then(job);
  const tail = run.then(
    () => {},
    () => {}
  );
  replyChains.set(chatId, tail);
  void tail.then(() => {
    if (replyChains.get(chatId) === tail) replyChains.delete(chatId);
  });
  return run;
}

let repliesInFlight = 0;
/** Сколько ответов ждут окно или идут прямо сейчас — мягкая остановка поллера
 *  (telegram/poller.ts, isTelegramPollerBusy) ждёт и их. */
export function telegramRepliesInFlight(): number {
  return repliesInFlight;
}

/**
 * Ответ на сообщение — после окна склейки, тем же механизмом, что в каналах
 * Meta (messengers/debounceBuffer.ts): текст ложится в буфер диалога, вызов ждёт
 * окно, и если за это время клиент дописал ещё — молча выходит, а отвечает
 * последний, за всю пачку сразу. Окно то же (Настройки → Бот), и то же правило
 * для принятой заявки и для фото (batchWindowFor).
 *
 * Никогда не отклоняется: сообщение клиента уже в переписке, и сбой ответа —
 * повод для журнала, а не для повторной доставки апдейта (она бы задвоила
 * реплику).
 */
async function replyAfterWindow(p: {
  conversationId: string;
  chatId: string;
  text: string;
  /** Карточка диалога в момент приёма — по ней видно, что заявку приняли, пока ждали окно. */
  registeredClientId: string | null;
  images: ImageInput[];
  voice: boolean;
  hasMedia: boolean;
  messageId?: number;
  peerBudget: Awaited<ReturnType<typeof loadPeerAiBudget>> | null;
}): Promise<void> {
  repliesInFlight++;
  try {
    stashBatchImages(p.conversationId, p.images);
    const batch = await debounceAndMerge<TelegramBatchEntry>(
      "TelegramConversation",
      p.conversationId,
      p.text,
      { voice: p.voice, media: p.hasMedia, messageId: p.messageId },
      batchWindowFor({ accepted: !!p.registeredClientId, hasMedia: p.hasMedia })
    );
    if (!batch) return; // клиент дописал — ответит более свежий вызов, за всю пачку
    const images = drainBatchImages(p.conversationId);
    const merged = batch.texts.filter(Boolean).join("\n") || p.text;
    await inReplyChain(p.chatId, () =>
      replyToBatch({
        conversationId: p.conversationId,
        chatId: p.chatId,
        text: merged,
        registeredClientId: p.registeredClientId,
        images,
        voice: batch.entries.some((e) => e?.voice === true),
        hasMedia: batch.entries.some((e) => e?.media === true),
        lastMessageId: [...batch.entries].reverse().find((e) => e?.messageId != null)?.messageId,
        peerBudget: p.peerBudget,
      })
    );
  } catch (err) {
    console.error("[telegram] ответ после окна склейки:", describeError(err));
    void logSystemError("telegram", `Ответ бота в Telegram не собран (чат ${p.chatId}): ${describeError(err)}`);
  } finally {
    repliesInFlight--;
  }
}

/** Ход модели на всю пачку — по свежему состоянию диалога, прочитанному ПОСЛЕ окна. */
async function replyToBatch(p: {
  conversationId: string;
  chatId: string;
  text: string;
  registeredClientId: string | null;
  images: ImageInput[];
  voice: boolean;
  hasMedia?: boolean;
  lastMessageId?: number;
  peerBudget: Awaited<ReturnType<typeof loadPeerAiBudget>> | null;
}): Promise<void> {
  const conversation = await prisma.telegramConversation.findUnique({
    where: { id: p.conversationId },
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
  if (!conversation) return;
  /**
   * ЗА ОКНО МНОГОЕ МОГЛО ПОМЕНЯТЬСЯ — перепроверяем то, что сообщение проверяло
   * на входе. Сотрудник взял диалог (пауза оператора) или выключили бота —
   * молчим: слова клиента уже в переписке. Заявку приняли, пока ждали (клиент
   * дописал номер, и бот уже ответил «заявка принята»), — второй ответ на те же
   * слова не нужен.
   */
  if (!(await isBotEnabledForChannel("TELEGRAM"))) return;
  if (await isOperatorPauseActive(conversation.pausedUntil, conversation.botPausedAt, conversation.clientId)) return;
  if (!p.registeredClientId && conversation.clientId) return;

  const history = (conversation.messages as unknown as ChatMessage[]) ?? [];
  // Последняя реплика — не клиента: на пачку уже ответил ход, прочитавший её
  // целиком (две доставки у принятой заявки, окно нулевое) — молчим.
  const last = history.at(-1);
  if (!last || last.role !== "user") return;
  const draft = (conversation.leadDraft as unknown as LeadDraft) ?? { stage: "chatting" };

  /**
   * ИСТОРИЯ ДЛЯ МОДЕЛИ — СВЕЖАЯ, ПОСЛЕ ОКНА. Каждое сообщение пачки уже лежит в
   * ней своей репликой (saveIncoming до окна), поэтому модель видит их все и
   * отвечает один раз на всё сразу. Для окончания хода (finishTelegramQualifyTurn)
   * история — то, что было ДО неотвеченных слов клиента, а сами слова — `text`
   * всей пачки: так же, как раньше для одного сообщения.
   */
  let cut = history.length;
  while (cut > 0 && history[cut - 1].role === "user") cut--;
  const priorHistory = history.slice(0, cut);

  /**
   * «ОК», ГОЛАЯ ПЕРЕСЫЛКА, ЕЩЁ ФОТО БЕЗ СЛОВ — БЕЗ ХОДА МОДЕЛИ (03.10.2026,
   * аудит audit-1, находка 8): те же отсечки, что в каналах Meta, общей функцией
   * (messengers/replyChain.ts::silentTurnReason). Слова клиента уже в переписке.
   * На «Ок» — реакция 👍, как настоящая реакция в WhatsApp.
   */
  const silence = silentTurnReason({ text: p.text, hasMedia: p.hasMedia ?? p.images.length > 0, history: priorHistory });
  if (silence) {
    if (silence === "ack_only" && p.lastMessageId != null) {
      await setMessageReaction(p.chatId, p.lastMessageId, "👍");
    }
    return;
  }

  /**
   * ПРИСЛАННАЯ ССЫЛКА ЧИТАЕТСЯ И ЗДЕСЬ (21.09.2026, требование владельца «везде
   * одни и те же правила»). До этой правки обогащение ссылок жило ТОЛЬКО в
   * канале Meta: человек, приславший в Telegram ссылку на наш же объект или на
   * чужое объявление, получал ответ, будто ничего не присылал.
   *
   * Подсказка добавляется только к копии для модели: в переписке реплика клиента
   * остаётся как есть. Ищется по словам всей пачки.
   */
  const linkHint = await sharedMediaHint({ text: p.text, channel: "TELEGRAM", recipientId: p.chatId });
  const promptHistory: ChatMessage[] = linkHint
    ? [...history.slice(0, -1), { ...last, content: `${last.content}\n${linkHint}` }]
    : history;

  // Ползунки «Что бот умеет» действуют и в Telegram. До 16.08.2026 сюда не
  // передавалось НИЧЕГО, то есть abilities по умолчанию «умеет всё»: владелец
  // выключал показы в Настройках — Instagram/WhatsApp переставали назначать,
  // а Telegram продолжал. Рубильник, работающий в части каналов, хуже его
  // отсутствия: поведение бота перестаёт совпадать с тем, что видно в Настройках.
  const capabilities = await loadBotCapabilities();
  const abilities = botAbilitiesOf(capabilities);
  // Расход засчитывается ПЕРЕД вызовом: платит сама попытка, а не удачный ответ
  // (то же правило, что в messengers/conversation.ts). Пачка сообщений — ОДИН ход:
  // списывает его только победитель окна. Фоновый повтор ниже отдельным ходом НЕ
  // считается — это доведение до конца той же попытки, за которую уже заплачено.
  if (p.peerBudget) await spendAiTurns(p.peerBudget.row.id, p.peerBudget.budget.dayKey, 1, "peer");
  /**
   * ТЕЛЕФОН УЖЕ НАШ — НЕ ПРОСИТЬ ЕГО СНОВА (ночная проверка 24.09.2026, находка
   * №116/Г6). Тот же приём, что `clientPhoneKnown` в messengers/conversation.ts
   * (22.09.2026, см. `phoneKnown` в ai/leadQualifier.ts): без этой строки модель,
   * продолжив разговор с уже принятым клиентом, просила бы номер, который уже в
   * карточке.
   */
  const clientPhoneKnown = conversation.clientId
    ? !!(
        await prisma.client
          .findUnique({ where: { id: conversation.clientId }, select: { phone: true } })
          .catch(() => null)
      )?.phone
    : false;
  // Фото уходят модели vision-блоками: клиент присылает планировку или скриншот
  // объявления и спрашивает по нему — без картинки бот отвечал бы наугад.
  // scenarioId не передаётся НАРОЧНО: сравнение манер продажи идёт только по
  // BotConversation (Instagram/Facebook/WhatsApp), у TelegramConversation такого поля
  // нет и статистика его не считает. Telegram у нас обслуживает в основном задачи
  // сотрудников, а не клиентов, и держать его вне опыта правильно — иначе пришлось бы
  // заводить колонку ради потока, которого там почти нет.
  // showcase не передаётся тоже: отправка фотографий в чат есть только в каналах Meta
  // (см. messengers/propertyShowcase.ts), и промт по умолчанию считает, что показа нет.
  const result = await runQualifyTurn(promptHistory, draft, {
    images: p.images,
    abilities,
    conversationId: conversation.id,
    contactProfile: await contactProfileForPrompt(conversation.contactProfileId, draft),
    phoneKnown: clientPhoneKnown,
  });

  if (!result) {
    /**
     * ИИ не ответил — МОЛЧИМ и пробуем в фоне, а не отвечаем русской заглушкой
     * (решение владельца 03.08.2026 для каналов Meta: клиент вообще не должен
     * видеть, что что-то пошло не так). Его слова уже в переписке (saveIncoming
     * до окна), поэтому терять нечего.
     *
     * С 13.09.2026 повтор ПЕРСИСТЕНТНЫЙ (jobs/telegramReplyRetry.ts), тем же
     * способом, что каналы Meta и сайт с 27.08.2026 (messengers/conversation.ts):
     * раньше здесь жил ai/aiRetryQueue.ts — setTimeout в памяти процесса до ~13
     * часов, замыкание держало СНИМОК истории, и любой деплой (а их несколько в
     * день) убивал ожидающий ответ и/или отвечал по устаревшей истории. Задание
     * переживает перезапуск и проигрывает ход ЗАНОВО по свежей истории из БД
     * (jobs/telegramReplyRetry.ts вызывает finishTelegramQualifyTurn ровно так
     * же, как обычный ход) — снимок диалога больше не нужен.
     *
     * dedupeKey на диалог: пока задание ждёт или исполняется, повторные отказы
     * модели по тому же диалогу новых заданий не плодят.
     */
    void enqueueBackgroundJob({
      type: "telegram-reply-retry",
      payload: { conversationId: conversation.id },
      dedupeKey: `telegram-reply-retry:${conversation.id}`,
      maxAttempts: AI_REPLY_RETRY_MAX_ATTEMPTS,
    });
    return;
  }

  // Окончание хода — общей функцией finishTelegramQualifyTurn, чтобы ЕЁ ЖЕ вызывал
  // персистентный повтор jobs/telegramReplyRetry.ts. Иначе отложенный ответ
  // пришлось бы собирать вторым куском кода, и правила («не здороваться дважды»,
  // «не бросать просьбу о номере») разошлись бы между обычным ходом и повтором.
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
    history: priorHistory,
    text: p.text,
    turn: result,
    capabilities,
    incomingWasVoice: p.voice,
    phoneKnown: clientPhoneKnown,
  });
}
