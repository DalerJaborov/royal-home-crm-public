import { prisma } from "../db.js";
import { sharedMediaHint } from "./sharedMedia.js";
import { publishMessageNew } from "../lib/livePublish.js";
import { scheduleSellerFactsRefreshForConversation } from "../lib/sellerFacts.js";
import {
  attachContactProfile,
  categoryForLeadKind,
  linkContactProfileToClient,
  recordContactTurn,
} from "../lib/contactProfiles.js";
import { recordAudienceMessage } from "../lib/audienceHeatmap.js";
import { contactProfileForPrompt, rememberContactTurn } from "../lib/contactProfileMemory.js";
import { collectSellerFacts } from "../ai/sellerIntake.js";
import { logSystemError } from "../lib/systemError.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";
import { noteRealInbound, repeatBlockedTexts } from "../lib/outboundShield.js";
import { describeError } from "../lib/describeError.js";
import { markLastTelegramReplyUndelivered } from "./appendMessages.js";
import { notifyAgentOfClientMessage } from "../lib/clientMessageAlert.js";
import { applyShowingRequestInBackground } from "../lib/showingBooking.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { AI_REPLY_RETRY_MAX_ATTEMPTS } from "../jobs/aiReplyRetryPolicy.js";
import { storeFetchedAttachments } from "./attachments.js";
import { fetchTelegramAlbumAttachments, telegramUnsupportedMark } from "../telegram/attachments.js";
import { isTranscriptionEnabled, transcribeAudio } from "../ai/transcribe.js";
import { stripUntrusted, wrapUntrusted } from "../ai/untrustedContent.js";
import type { ChatMessage, ImageInput, StoredAttachment } from "../ai/client.js";
import { mergeDraft, runQualifyTurn } from "../ai/leadQualifier.js";
import { extractTypedPhone, extractVolunteeredPhone, normalizeDigits } from "../lib/shared/phoneText.js";
import { lastClientLanguage } from "../ai/shortAgentReply.js";
import { type LeadDraft } from "../ai/leadDraft.js";
import { clientSelfStatedName, mentionsPhoneRequest, phoneReminder } from "../ai/replyGuards.js";
import { countPhoneAsksIn } from "../ai/replyRepeatGuard.js";
import { isOtherCityReason } from "../ai/leadKind.js";
import {
  FALLBACK_VOICE,
  finalizeBotReply,
  inClientLanguage,
  lastClientWords,
  recentBotText,
  silentTurnReason,
  type FallbackText,
} from "./replyChain.js";
import {
  FALLBACK_ACCEPTED,
  FOREIGN_CONTACT_REPLY,
  JOB_ACCEPTED_REPLY,
  JOB_TELL_ABOUT_YOURSELF,
  leadAcceptedReply,
} from "./leadAcceptedReply.js";
import { chatTypingPauseMs, sleep } from "./humanPacing.js";
import { screenIncomingText } from "../ai/inboundScreen.js";
import { loadPeerAiBudget, noticeAiBudgetHandover, spendAiFiles, spendAiTurns, type AiFileKind } from "../lib/aiDailyBudget.js";
import { createLeadFromChannel } from "../leads.js";
import { captureCandidate, candidateStoryCollected } from "../lib/jobApplications.js";
import { classifyInbound } from "../services/leads/intakePolicy.js";
import { looksLikeRentRequest, rentRefusalReply } from "../ai/rentGuard.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { sendChatAction, sendMessage, sendVoice, setMessageReaction, type TelegramIncomingMessage } from "../telegram/api.js";
import { isBotEnabledForChannel } from "./botChannels.js";
import { botAbilitiesOf, loadBotCapabilities } from "./botCapabilities.js";
import { synthesizeChatVoiceReply, pcmToWavBuffer } from "../ai/tts.js";
import { transcodeToOggOpus } from "../lib/audioTranscode.js";
import { saveOutgoingVoice } from "../lib/outgoingVoice.js";
import { publicUploadUrl } from "../lib/crmPublicUrl.js";
import { recordOwnerQuestion } from "../lib/ownerQuestions.js";
import { isWithinWorkingHours } from "../lib/workingHours.js";

/**
 * Служебные фразы — на языке клиента (ревизия бота 02.10.2026), общей функцией
 * inClientLanguage из messengers/replyChain.ts (03.10.2026, «один мозг»): та же,
 * что у каналов Meta и Telegram-бота.
 */
/** Ответ «заявка уже у агента» — один раз подряд, а не на каждое сообщение. */
const ALREADY_ACCEPTED: FallbackText = {
  ru: "Ваша заявка уже у агента, он свяжется с вами. Если хотите что-то добавить — напишите, я передам.",
  tg: "Дархости шумо аллакай дар агент аст, ӯ бо шумо тамос мегирад. Агар чизе илова кардан хоҳед — нависед, мерасонам.",
};

/**
 * Сотрудник канала ответил в разговоре сам (03.10.2026, аудит audit-1, находка 17)
 * — бот молчит столько же, сколько после разовой помощи сотрудника в инбоксе
 * (OPERATOR_REPLY_PAUSE_MS_SHORT в lib/conversationDelivery.ts, значение
 * продублировано: импорт оттуда тянул бы цикл через messengers/conversation.ts).
 * Не бессрочно: кнопки «Вернуть боту» у этого канала в CRM нет.
 */
const STAFF_REPLY_PAUSE_MS = 10 * 60 * 1000;

/** Карточку завести не вышло, но номер в журнале — сотрудник заведёт руками. */
const NUMBER_SAVED_REPLY: FallbackText = {
  ru: "Номер записал, агент свяжется с вами.",
  tg: "Рақамро сабт кардам, агент бо шумо тамос мегирад.",
};

/**
 * Direct Messages канала (01.09.2026, t.me/<канал>?direct) — та же ИИ-квалификация
 * лидов, что в личке с ботом (telegram/bot.ts handleClientMessages), но НЕ тот же
 * код и НЕ та же таблица. Причина: в личке chat.id уникален для каждого клиента,
 * а в Direct Messages ВСЕ отправители делят один и тот же chat.id (сам канал),
 * Telegram различает их только через direct_messages_topic.topic_id (форма
 * апдейта проверена вживую getUpdates 01.09.2026). Диалог здесь ключуется парой
 * (chatId, topicId) — TelegramDirectConversation, отдельная модель, чтобы не
 * рисковать TelegramConversation (личные чаты сотрудников и клиентов).
 *
 * Сознательно НЕ перенесено сюда из handleClientMessages:
 *  - явная ветка "/start" с кнопками (Mini App каталога, «Позвать агента») —
 *    в Direct Messages это не отдельная команда запуска бота, а обычная первая
 *    реплика человека; первое приветствие даёт сама модель по системному промту;
 *  - нативная кнопка «Поделиться номером» (requestContact) — reply-клавиатура
 *    внутри топика Direct Messages не проверена вживую, безопаснее просить номер
 *    обычным текстом, как это уже сделано для комментариев группы-обсуждения
 *    (messengers/telegramGroupComments.ts).
 * Карточка клиента заводится БЕЗ telegramChatId/telegramUsername (в отличие от
 * личных чатов): это поле уникально на Client и означает «сюда можно написать
 * напрямую по chat_id», а у Direct Messages для ответа человеку нужен ЕЩЁ и
 * topicId — писать в общий chat_id без него ушло бы не в тот топик. Пока это
 * не подключено в путь «сотрудник отвечает клиенту из CRM вручную» — бот ведёт
 * такой диалог от начала до конца сам, как и с комментариями группы-обсуждения.
 */

interface DirectSettings {
  enabled: boolean;
}

async function loadDirectSettings(): Promise<DirectSettings> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramDirectMessagesEnabled: true },
  });
  return { enabled: settings?.telegramDirectMessagesEnabled ?? false };
}

/** Тот же общий рубильник «Отвечать» (Настройки → Бот), что у остальных
 *  каналов Telegram, поверх собственного тумблера Direct Messages. */
export async function isTelegramDirectMessagesEnabled(settings?: DirectSettings): Promise<boolean> {
  const s = settings ?? (await loadDirectSettings());
  if (!s.enabled) return false;
  return isBotEnabledForChannel("TELEGRAM");
}

async function getDirectConversation(chatId: string, topicId: string, fromUserId: string | undefined, username: string | undefined) {
  const lastMessageAt = new Date();
  const conversation = await prisma.telegramDirectConversation.upsert({
    where: { chatId_topicId: { chatId, topicId } },
    update: { ...(username ? { username } : {}), lastMessageAt },
    create: {
      chatId,
      topicId,
      fromUserId,
      username,
      messages: [],
      leadDraft: { stage: "chatting" } as any,
      lastMessageAt,
    },
  });
  // ДОСЬЕ СОБЕСЕДНИКА — тот же шаг, что у остальных каналов.
  //
  // Признак ЧЕЛОВЕКА здесь — fromUserId (тот же id, что в личке бота: написавший
  // каналу и написавший боту сходятся в одно досье сами). chatId у этого канала
  // ОДИН НА ВСЕХ (это DM-инбокс канала), и связывать по нему значило бы склеить
  // всех написавших в одного человека — поэтому в признаки идёт пара с темой.
  const contactProfileId = await attachContactProfile({
    existingProfileId: conversation.contactProfileId,
    identities: [
      ...(fromUserId ? [{ kind: "TG_CHAT_ID" as const, value: fromUserId, trust: "TRANSPORT" as const }] : []),
      { kind: "TG_DM_TOPIC", value: `${chatId}:${topicId}`, trust: "TRANSPORT" },
      { kind: "TG_USERNAME", value: username, trust: "PROFILE" },
    ],
    link: async (profileId) => {
      await prisma.telegramDirectConversation.update({
        where: { id: conversation.id },
        data: { contactProfileId: profileId },
      });
    },
  });
  return { ...conversation, contactProfileId };
}

/** Тот же предел, что у TelegramConversation (messengers/conversation.ts) —
 *  без обрезки история росла бы неограниченно. */
const MAX_STORED_MESSAGES = 40;

/** Та же техника хранения истории, что у TelegramConversation
 *  (messengers/conversation.ts appendTelegramConversationMessages) — отдельная
 *  функция, потому что таблица другая, а raw SQL нельзя параметризовать по имени. */
async function appendDirectConversationMessages(conversationId: string, newMessages: ChatMessage[]): Promise<void> {
  if (newMessages.length === 0) return;
  const stampedAt = new Date().toISOString();
  const stamped = newMessages.map((m) => (m.at ? m : { ...m, at: stampedAt }));
  await prisma.$executeRaw`
    UPDATE "TelegramDirectConversation"
    SET "messages" = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM (
        SELECT elem, ord
        FROM jsonb_array_elements("messages" || ${JSON.stringify(stamped)}::jsonb) WITH ORDINALITY AS t(elem, ord)
        ORDER BY ord DESC
        LIMIT ${MAX_STORED_MESSAGES}
      ) AS tail
    ),
    "updatedAt" = now()
    WHERE "id" = ${conversationId}`;
  // Живое событие — из единственного места записи истории этого канала.
  const incoming = stamped.some((m) => m.role === "user");
  void publishMessageNew("telegram-direct", conversationId, incoming ? "IN" : "OUT");
  // Факты объекта продавца — то же, что у остальных каналов (messengers/appendMessages.ts).
  if (incoming) scheduleSellerFactsRefreshForConversation("telegram-direct", conversationId);
}

/**
 * ПАУЗА, ПОСТАВЛЕННАЯ ПОКА БОТ ДУМАЛ (аудит Codex 04.10.2026, находка №11).
 *
 * `isPaused` в handleTelegramDirectMessage считается один раз, по строке диалога,
 * прочитанной в начале хода; ветка fromStaff между тем ставит `pausedUntil`, когда
 * сотрудник отвечает из самого Telegram. Тот же приём, что в каналах Meta
 * (messengers/conversation.ts) и личке бота (telegram/bot.ts): пауза
 * перечитывается из базы и сравнивается с паузой НА НАЧАЛО ХОДА — протухшая
 * «бессрочная» пауза потерянного клиента, которую ход сознательно обошёл, новой не
 * считается. Читаем сырое поле, а не isOperatorPauseActive: нужна именно разница с
 * началом хода.
 */
async function staffTookOverSince(conversationId: string, pausedUntilAtStart: Date | null | undefined): Promise<boolean> {
  const pauseNow = await prisma.telegramDirectConversation
    .findUnique({ where: { id: conversationId }, select: { pausedUntil: true } })
    .then((row) => row?.pausedUntil ?? null)
    .catch(() => null);
  return !!pauseNow && pauseNow.getTime() > Date.now() && pauseNow.getTime() !== (pausedUntilAtStart?.getTime() ?? null);
}

/**
 * Окончание хода ИИ в Direct Messages — вынесено ОБЩЕЙ функцией (13.09.2026,
 * тот же чертёж Б2, что и у личных чатов telegram/bot.ts), чтобы её же вызывал
 * и живой ход, и персистентный повтор jobs/telegramDirectReplyRetry.ts.
 */
export async function finishTelegramDirectQualifyTurn(params: {
  /* phoneAsksSent обязателен в типе, а не «если есть»: забытый select дал бы
   * молчаливый ноль и вернул ровно ту поломку, которую эта правка закрывает. */
  conversation: {
    id: string;
    clientId: string | null;
    phoneAsksSent: number;
    /** Досье собеседника — память бота о человеке (lib/contactProfileMemory.ts). */
    contactProfileId?: string | null;
  };
  chatId: string;
  topicId: number;
  draft: LeadDraft;
  history: ChatMessage[];
  text: string;
  turn: NonNullable<Awaited<ReturnType<typeof runQualifyTurn>>>;
  capabilities?: Awaited<ReturnType<typeof loadBotCapabilities>>;
  /** Клиент в ЭТОМ ходе прислал голосовое — условие для голосового ответа
   *  (см. телеграм-личку telegram/bot.ts, тот же приём). Повтор из
   *  jobs/telegramDirectReplyRetry.ts голосового вложения уже не видит. */
  incomingWasVoice?: boolean;
  /** Номер уже в карточке — второй раз не просим (как у лички бота и каналов Meta). */
  phoneKnown?: boolean;
  /** `pausedUntil` диалога на НАЧАЛО хода: с ним сравнивается пауза, перечитанная
   *  перед отправкой (см. staffTookOverSince). Не передан — как «паузы не было». */
  pausedUntilAtStart?: Date | null;
}): Promise<void> {
  const {
    conversation,
    chatId,
    topicId,
    draft,
    history,
    text,
    turn,
    capabilities,
    incomingWasVoice = false,
    phoneKnown = false,
    pausedUntilAtStart = null,
  } = params;
  const reply = (t: string) => sendMessage(chatId, t, undefined, topicId);

  const mergedDraft = mergeDraft(draft, turn, text);
  if (draft.stage === "awaiting_phone") mergedDraft.stage = "awaiting_phone";

  /**
   * ЦЕПОЧКА ФИЛЬТРОВ ОТВЕТА — ТА ЖЕ ФУНКЦИЯ, ЧТО У КАНАЛОВ META И ЛИЧКИ БОТА
   * (messengers/replyChain.ts::filterBotReply; Dan 03.10.2026, «один мозг»;
   * аудит audit-1, находки 7 и 9). Удержание темы здесь не действует: состояние
   * темы хранят только колонки BotConversation.
   */
  const botSpokeBefore = history.some((m) => m.role === "assistant");
  const botSaidBefore = history.filter((m) => m.role === "assistant").map((m) => m.content);
  const clientSaid = `${history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ")} ${text}`;
  const turnLanguageRaw = detectClientLanguage(text);
  const turnLanguage = turnLanguageRaw === "unknown" ? lastClientLanguage(history) : turnLanguageRaw;
  // Ответ съели фильтры — не молчим (аудит 10.10.2026, P0-1): короткая нейтральная
  // реплика; ключ щита — собеседник темы (`chatId:topicId`, как в telegram/api.ts).
  const filtered = await finalizeBotReply({
    reply: turn.reply,
    conversationId: conversation.id,
    channelLabel: "TELEGRAM Direct Messages",
    openUrl: `/messages?open=${conversation.id}`,
    botSpokeBefore,
    botSaidBefore,
    clientSaidTrusted: stripUntrusted(clientSaid, ["document", "video"]),
    clientTurnText: text,
    previousBotText: recentBotText(history),
    language: turnLanguage,
    draft: mergedDraft,
    jobConversation: mergedDraft.intent === "job",
    phoneAsksSent: conversation.phoneAsksSent ?? 0,
    phoneKnown,
    fallbackLanguageWords: [text, lastClientWords(history)],
  }, { shieldBlocked: (bubbles) => repeatBlockedTexts("TELEGRAM", `${chatId}:${topicId}`, bubbles) });
  /**
   * Слова клиента уже в переписке, черновик и досье ниже сохраняются как обычно:
   * не уходит и не пишется только ответ бота (след в журнале, как в telegram/bot.ts).
   */
  const staffTookOver = filtered.bubbles.length > 0 && (await staffTookOverSince(conversation.id, pausedUntilAtStart));
  if (staffTookOver) {
    void logSystemError(
      "ai",
      `Сотрудник взял диалог ${conversation.id} (TELEGRAM Direct Messages), пока бот готовил ответ, — ответ бота не отправлен.`,
      { url: `/messages?open=${conversation.id}` }
    );
  }
  const replyBubbles = staffTookOver ? [] : filtered.bubbles;

  if (replyBubbles.length > 0) {
    await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: replyBubbles.join("\n"), by: { kind: "bot" } }]);
  }
  /* Счётчик просьб номера — по реально ушедшим пузырям (просьбу мог вычеркнуть
   * dropPhoneAsks) и прибавкой в самой БД, чтобы параллельный ход не затёрся. */
  const phoneAsksJustSent = countPhoneAsksIn(replyBubbles);
  await prisma.telegramDirectConversation.update({
    where: { id: conversation.id },
    data: {
      leadDraft: mergedDraft as any,
      ...(phoneAsksJustSent > 0 ? { phoneAsksSent: { increment: phoneAsksJustSent } } : {}),
    },
  });
  // «Уточню у собственника» — обещание записывается, как в каналах Meta
  // (messengers/conversation.ts): раньше здесь оно оставалось только словами.
  if (turn.askOwner && capabilities?.askOwner) {
    void recordOwnerQuestion({ conversationId: conversation.id, clientId: conversation.clientId, question: turn.askOwner });
  }
  // Досье человека — той же функцией, что в остальных каналах.
  await rememberContactTurn({
    profileId: conversation.contactProfileId,
    conversationId: conversation.id,
    draft: mergedDraft,
    sellerFacts: mergedDraft.intent === "sell" ? collectSellerFacts(history) : null,
    selfName: clientSelfStatedName(history),
  });

  /**
   * ОТПРАВКА — ПОД ОТМЕТКОЙ «НЕ ДОСТАВЛЕНО» (правка 22.09.2026). Тот же довод,
   * что в личке telegram/bot.ts и в каналах Meta: реплика лежит в переписке
   * ДО отправки, `reply` бросает на любой отказ Bot API, а Telegram наш 200 уже
   * получил. Без отметки сотрудник видит «бот ответил» и сам не пишет.
   */
  /*
   * БЕЗ «Записал: …» И БЕЗ ВТОРОЙ ПРОСЬБЫ НОМЕРА (ревизия бота 02.10.2026). Сводка
   * анкетой в конце ответа читалась как бланк, а дежурное «напишите номер» уходило
   * по-русски следом за пузырём, где модель номер уже попросила, и мимо счётчика
   * просьб. Теперь просьба добавляется, только если её в ответе нет и лимит не
   * исчерпан, на языке клиента и с учётом в счётчике.
   */
  /*
   * По этапу «ждём номер», а не по `turn.ready` (03.10.2026, аудит audit-1,
   * находка 5): другой город, заграница и аренда этот этап нарочно не получают
   * (mergeDraft), и просить у них номер «чтобы агент связался» нельзя. Фраза —
   * общая phoneReminder на языке разговора (без запрещённого «лутфан»). На пустой
   * ответ (вычистили проверки) одинокую просьбу номера не шлём.
   */
  const addPhoneAsk =
    replyBubbles.length > 0 &&
    mergedDraft.stage === "awaiting_phone" &&
    !conversation.clientId &&
    !filtered.stopAskingPhone &&
    countPhoneAsksIn(replyBubbles) === 0 &&
    // Прошлым сообщением уже просили — второй раз подряд не просим (то же
    // правило, что у ensurePhoneAskKept).
    !mentionsPhoneRequest(recentBotText(history));
  let deliveredAny = false;
  try {
    // «Печатает…» и пауза набора перед каждым пузырём — как у каналов Meta
    // (03.10.2026, аудит audit-1, находка 6; messengers/humanPacing.ts).
    // Пауза перечитывается ПОСЛЕ набора и перед каждым пузырём: набор занимает
    // секунды на пузырь, и сотрудник успевает вклиниться между пузырями.
    let interrupted = false;
    for (const [i, bubble] of replyBubbles.entries()) {
      await sendChatAction(chatId, topicId);
      await sleep(chatTypingPauseMs(bubble, i === 0 ? 3000 : 6000));
      if (await staffTookOverSince(conversation.id, pausedUntilAtStart)) {
        interrupted = true;
        break;
      }
      await reply(bubble);
      deliveredAny = true;
    }
    if (interrupted) {
      void logSystemError(
        "ai",
        `Сотрудник взял диалог ${conversation.id} (TELEGRAM Direct Messages) посреди ответа бота, остаток не отправлен.`,
        { url: `/messages?open=${conversation.id}` }
      );
      if (!deliveredAny) await markLastTelegramReplyUndelivered("telegram-direct", conversation.id);
    } else if (addPhoneAsk) {
      const ask = phoneReminder(turnLanguage);
      await sendChatAction(chatId, topicId);
      await sleep(chatTypingPauseMs(ask, 6000));
      if (await staffTookOverSince(conversation.id, pausedUntilAtStart)) return;
      await reply(ask);
      await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: ask, by: { kind: "bot" } }]);
      await prisma.telegramDirectConversation
        .update({ where: { id: conversation.id }, data: { phoneAsksSent: { increment: 1 } } })
        .catch((err) => console.error("[telegram-dm] счётчик просьб номера:", describeError(err)));
    }
  } catch (err) {
    if (!deliveredAny && replyBubbles.length > 0) {
      await markLastTelegramReplyUndelivered("telegram-direct", conversation.id);
    }
    void logSystemError(
      "ai",
      `Ответ бота не доставлен в Telegram Direct Messages (диалог ${conversation.id}): ${describeError(err)}`
    );
    throw err;
  }

  /**
   * ГОЛОСОВОЙ ОТВЕТ — тот же принцип, что в личке telegram/bot.ts и каналах
   * Meta (messengers/conversation.ts, 13.09.2026): только если клиент сам
   * прислал голосовое в этом ходе, и только когда рубильник включён.
   *
   * ПОЧЕМУ НЕ deliverVoiceToConversation: та функция умеет только
   * BotConversation (каналы Meta) и TelegramConversation (личка бота) — у
   * Direct Messages канала СВОЯ таблица (TelegramDirectConversation) и свой
   * составной ключ (chatId+topicId), которых нет в DeliveryTarget. Поэтому
   * здесь — короткий путь напрямую через те же кирпичи (transcodeToOggOpus,
   * saveOutgoingVoice, publicUploadUrl, sendVoice), без общей защиты
   * checkAgentVoiceMessage: та защита — от ЖИВОГО агента, слившего номер
   * голосом, а не от бота, отвечающего своим же уже проверенным текстом.
   */
  if (capabilities?.voiceReplies && incomingWasVoice && replyBubbles.length > 0) {
    try {
      const speech = await synthesizeChatVoiceReply(replyBubbles.join("\n"));
      if (speech) {
        const wav = pcmToWavBuffer(Buffer.from(speech.audioBase64, "base64"), speech.sampleRateHz);
        const ogg = await transcodeToOggOpus(wav);
        const publicPath = ogg ? await saveOutgoingVoice(ogg, "ogg") : null;
        const absoluteUrl = publicPath ? publicUploadUrl(publicPath) : null;
        if (absoluteUrl) await sendVoice(chatId, absoluteUrl, topicId);
      }
    } catch (err) {
      console.error("[голосовой ответ] telegram direct:", err instanceof Error ? err.message : err);
    }
  }
}

export async function handleTelegramDirectMessage(msg: TelegramIncomingMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const topic = msg.direct_messages_topic;
  if (!topic) return;
  const topicId = String(topic.topic_id);
  const fromUserId = topic.user?.id != null ? String(topic.user.id) : msg.from?.id != null ? String(msg.from.id) : undefined;
  const username = topic.user?.username ?? msg.from?.username;

  if (!(await isTelegramDirectMessagesEnabled())) return;

  /**
   * В ТЕМЕ НАПИСАЛ НЕ ЕЁ ЧЕЛОВЕК (03.10.2026, аудит audit-1, находка 17). Тема
   * Direct Messages — это разговор канала с ОДНИМ человеком (topic.user), но
   * писать в неё может и администратор канала: от своего имени (from.id другой)
   * или от лица канала (sender_chat). Раньше такая реплика сохранялась как слова
   * клиента и бот отвечал на неё — то есть спорил с сотрудником от имени клиента.
   * Теперь: в переписку — как ответ сотрудника из самого Telegram, бот на этой
   * теме молчит, как после ответа сотрудника в инбоксе.
   */
  const topicUserId = topic.user?.id;
  const fromStaff = !!msg.sender_chat || (topicUserId != null && msg.from?.id != null && msg.from.id !== topicUserId);
  if (fromStaff) {
    const existing = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId, topicId } },
      select: { id: true },
    });
    if (!existing) return;
    const staffText = (msg.text ?? msg.caption ?? "").trim();
    if (staffText) {
      await appendDirectConversationMessages(existing.id, [{ role: "assistant", content: staffText, by: { kind: "manual" } }]);
    }
    await prisma.telegramDirectConversation.update({
      where: { id: existing.id },
      data: { pausedUntil: new Date(Date.now() + STAFF_REPLY_PAUSE_MS) },
    });
    return;
  }

  /**
   * ЩИТ ИСХОДЯЩИХ ПОДКЛЮЧЁН И ЗДЕСЬ (правка 22.09.2026, lib/outboundShield.ts).
   *
   * Из трёх каналов бота Direct Messages был единственным без щита: ни «не
   * повторяйся дословно», ни предел монолога, ни ограничение инициативы там не
   * работали — при том, что отвечает в нём та же модель и теми же словами.
   * Подключать было нельзя, пока ключ щита у Telegram был `chatId`: у этого
   * инбокса он ОДИН на всех написавших, и первая же пауза накрыла бы весь
   * канал. Теперь ключ составной, `chatId:topicId` (telegram/api.ts
   * sendMessage и directKey в щите) — и пауза, и счётчики принадлежат одному
   * собеседнику.
   */
  await noteRealInbound({
    channel: "TELEGRAM",
    subscriberId: `${chatId}:${topicId}`,
    providerId: msg.message_id,
    name: username ?? null,
  });

  const conversation = await getDirectConversation(chatId, topicId, fromUserId, username);
  const draft = (conversation.leadDraft as unknown as LeadDraft) ?? { stage: "chatting" };
  const history = (conversation.messages as unknown as ChatMessage[]) ?? [];
  // Карточка уже есть — связываем с досье, как каналы Meta (аудит audit-1, находка 11).
  if (conversation.contactProfileId && conversation.clientId) {
    await linkContactProfileToClient(conversation.contactProfileId, conversation.clientId);
  }

  let text = (msg.text ?? msg.caption ?? "").trim();

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

  if (conversation.clientId) void notifyAgentOfClientMessage(conversation.clientId, text, "TELEGRAM", chatId);

  const isPaused = !!conversation.pausedUntil && conversation.pausedUntil.getTime() > Date.now();
  const botSpeaks = !isPaused;

  // Отдельный ключ бюджета ("TELEGRAM_DM"), не "TELEGRAM" — тот же приём, что у
  // комментариев группы-обсуждения ("TELEGRAM_COMMENTS"): разные функции не
  // должны делить один суточный счётчик ходов ИИ на одного и того же человека.
  const peerBudget = botSpeaks ? await loadPeerAiBudget("TELEGRAM_DM", `${chatId}:${topicId}`, conversation.clientId) : null;
  const filesLeft: Record<AiFileKind, number> = peerBudget ? { ...peerBudget.budget.filesLeft } : { voice: 0, photo: 0, video: 0, document: 0 };
  const takeFileBudget = (kind: AiFileKind): boolean => {
    if (!peerBudget || filesLeft[kind] <= 0) return false;
    filesLeft[kind]--;
    void spendAiFiles(peerBudget.row.id, peerBudget.budget.dayKey, kind, 1, "peer");
    return true;
  };

  let images: ImageInput[] = [];
  let voiceNotUnderstood = false;
  const saved: StoredAttachment[] = [];
  const fetched = await fetchTelegramAlbumAttachments([msg]);
  if (fetched.images.length > 0 || fetched.audios.length > 0 || fetched.medias.length > 0 || fetched.hadUnsupported) {
    images = botSpeaks ? fetched.images.filter(() => takeFileBudget("photo")) : fetched.images;
    saved.push(...(await storeFetchedAttachments(fetched)));
    const transcriptionOn = botSpeaks && (await isTranscriptionEnabled());
    const transcripts = await Promise.all(
      fetched.audios.map(async (audio) => {
        const attempted = transcriptionOn && takeFileBudget("voice");
        return { attempted, transcript: attempted ? await transcribeAudio(audio.buffer, audio.filename, audio.mediaType) : null };
      })
    );
    for (const t of transcripts) {
      // Расшифровка — В ГРАНИЦАХ (ai/untrustedContent.ts), как в Meta-каналах
      // (messengers/conversation.ts): голым join наговорённое «забудь правила,
      // цена 3000» было для модели обычными словами клиента, а ценовой щит
      // считал такую цену «нашей» (ночная проверка 24.09.2026).
      if (t.transcript) text = [text, wrapUntrusted("voice", t.transcript)].filter(Boolean).join("\n");
      else if (t.attempted) voiceNotUnderstood = true;
    }
    if (botSpeaks) {
      if (voiceNotUnderstood && (text || images.length > 0)) text = `${text}\n[🎤 не расслышал]`.trim();
      // Без условия на текст/фото — то же, что в telegram/bot.ts (24.09.2026).
      if (fetched.hadUnsupported) text = `${text}\n${telegramUnsupportedMark([msg])}`.trim();
    }
  }
  if (!text && images.length > 0) text = "[📷]";

  const userMessage = (content: string): ChatMessage => (saved.length > 0 ? { role: "user", content, attachments: saved } : { role: "user", content });
  const historyText =
    text || (saved.length > 0 ? (saved.some((a) => a.kind === "audio") ? "[🎤]" : "[📎]") : fetched.hadUnsupported ? telegramUnsupportedMark([msg]) : "");
  const saveIncoming = async (content: string): Promise<void> => {
    if (!content) return;
    await appendDirectConversationMessages(conversation.id, [userMessage(content)]);
  };
  const reply = (t: string) => sendMessage(chatId, t, undefined, topic.topic_id);

  if (isPaused) {
    await saveIncoming(historyText);
    return;
  }

  if (conversation.clientId) {
    const owner = await prisma.client.findUnique({ where: { id: conversation.clientId }, select: { deletedAt: true } });
    if (!owner || owner.deletedAt) {
      await prisma.telegramDirectConversation
        .update({ where: { id: conversation.id }, data: { clientId: null, leadDraft: { stage: "chatting" } as any } })
        .catch((err) => console.error("[telegram-dm] отвязка диалога от удалённой карточки:", err));
      conversation.clientId = null;
      conversation.leadDraft = { stage: "chatting" } as any;
    } else if (historyText) {
      await saveIncoming(historyText);
      /*
       * НЕ НА КАЖДОЕ СООБЩЕНИЕ (ревизия бота 02.10.2026). Раньше на любую реплику
       * после заявки уходило одно и то же «Ваша заявка уже принята» — пять
       * сообщений, пять одинаковых ответов. Теперь один раз подряд и на языке
       * клиента; дальше сообщение просто ложится в переписку, агента о нём
       * извещает общий путь входящих.
       */
      const lastBot = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
      if (lastBot !== ALREADY_ACCEPTED.ru && lastBot !== ALREADY_ACCEPTED.tg) {
        const notice = inClientLanguage(ALREADY_ACCEPTED, historyText, lastClientWords(history));
        await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: notice, by: { kind: "bot" } }]);
        await reply(notice);
      }
      return;
    } else {
      return;
    }
  }

  const typedPhone = text ? (draft.stage === "awaiting_phone" ? extractTypedPhone(text) : extractVolunteeredPhone(text)) : null;
  const ownContact = msg.contact && msg.contact.user_id != null && String(msg.contact.user_id) === (fromUserId ?? "");
  if (msg.contact && !ownContact) {
    await saveIncoming(`${historyText}\n[переслан чужой контакт: ${msg.contact.phone_number}]`.trim());
    const foreignReply = inClientLanguage(FOREIGN_CONTACT_REPLY, text, lastClientWords(history));
    await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: foreignReply, by: { kind: "bot" } }]);
    await reply(foreignReply);
    return;
  }
  if (msg.contact || typedPhone) {
    if (saved.length > 0) await saveIncoming(historyText);
    const phone = msg.contact ? normalizeDigits(msg.contact.phone_number.replace(/[^\d]/g, "")) : typedPhone!;
    const fullName = msg.contact?.first_name || topic.user?.first_name || msg.from?.first_name || "Клиент Telegram";

    // Одно правило поиска района на все каналы (lib/districtLookup.ts, 24.09.2026).
    const districtId = await findDistrictIdByName(draft.districtName);

    const clientWords = [...history.filter((m) => m.role === "user").map((m) => m.content), text ?? ""].filter(Boolean).join("\n");
    // П-13 (18.09.2026): через intakePolicy.classifyInbound, channel:"chat" —
    // тот же контракт, что и у messengers/conversation.ts.
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
    if (draft.intent === "rent" || looksLikeRentRequest(clientWords)) {
      if (saved.length === 0) await saveIncoming(historyText);
      const refusal = rentRefusalReply(clientWords);
      await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: refusal, by: { kind: "bot" } }]);
      await reply(refusal);
      return;
    }
    /**
     * КАНДИДАТ НА ВАКАНСИЮ (02.10.2026). Этот канал кандидатов не знал вовсе:
     * соискатель получал карточку «прочего обращения», уже существующая карточка
     * оставалась у агента, а в ответ человек читал «агент свяжется». Теперь — тем
     * же путём, что Telegram-бот и каналы Meta (lib/jobApplications.ts::
     * captureCandidate): анкета в «Вакансии», карточку не заводим, уже
     * существующую снимаем с агента, руководство зовём один раз за разговор.
     *
     * Канал анкеты — "TELEGRAM_DIRECT", а не "TELEGRAM": по каналу раздел
     * «Вакансии» выбирает, в какой из трёх таблиц переписки искать разговор, а
     * "TELEGRAM" — это таблица бота, где этого id нет.
     *
     * Диалог к найденной карточке НЕ привязываем: привязанному диалогу этот канал
     * отвечает штампом «Агент скоро свяжется» (ветка conversation.clientId выше).
     */
    if (decision.reason === "работа") {
      const { pendingShowing: _showing, ...draftWithoutShowing } = draft;
      await prisma.telegramDirectConversation.update({
        where: { id: conversation.id },
        data: { leadDraft: { ...draftWithoutShowing, stage: "done" } as any },
      });
      await captureCandidate({
        table: "telegramDirect",
        conversationId: conversation.id,
        channel: "TELEGRAM_DIRECT",
        name: fullName,
        ...(msg.contact ? { identityPhones: [phone] } : { typedPhones: [phone] }),
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
      // Обещать звонок кандидату нельзя (SCENARIO_JOB, владелец 20.09.2026: «просто
      // сказать, что ваша заявка будет рассмотрена»), и «принята» законно только
      // после рассказа о себе — иначе благодарим и просим рассказать.
      const storyKnown = await candidateStoryCollected(conversation.id);
      if (saved.length === 0) await saveIncoming(historyText);
      // Тексты — общие с личкой бота (messengers/leadAcceptedReply.ts).
      const answer = inClientLanguage(storyKnown ? JOB_ACCEPTED_REPLY : JOB_TELL_ABOUT_YOURSELF, clientWords);
      await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: answer, by: { kind: "bot" } }]);
      await reply(answer);
      return;
    }
    if (decision.kind === "OTHER" && decision.reason) {
      void logSystemError(
        "ai",
        `Заявка из Telegram Direct Messages заведена как «прочее обращение»: ${decision.reason}. Агенту не назначается. ` +
          `Слова клиента: «${clientWords.replace(/\s+/g, " ").slice(0, 160)}»`
      );
    }
    try {
      const { clientId, created } = await createLeadFromChannel({
        fullName,
        phone,
        source: "TELEGRAM",
        kind: decision.kind,
        // Та же пара, на которую sharedMediaHint пишет «клиент прислал ссылку на
        // объект», — без неё раздача не видела этих экспозиций и отдавала заявку
        // в общую очередь, а не агенту объекта (находка треда «Бот не узнаёт наш
        // пост в Instagram», 02.10.2026).
        channel: "TELEGRAM",
        recipientId: String(topicId),
        // Ночью — утренней волне, как в Instagram/WhatsApp/сайте (conversation.ts).
        deferAssignment: !(await isWithinWorkingHours()),
        budgetMin: draft.budgetMin,
        budgetMax: draft.budgetMax,
        desiredDistrictId: districtId,
        desiredRooms: draft.rooms,
        requirementsNotes:
          [draft.callbackTopic ? `📞 ПРОСИТ ПЕРЕЗВОНИТЬ: ${draft.callbackTopic}` : undefined, decision.label, draft.notes].filter(Boolean).join("\n") ||
          undefined,
        // Без telegramChatId/telegramUsername намеренно — см. докстринг файла:
        // на этот chat_id нельзя писать без topicId, а поле на Client рассчитано
        // на прямую переписку по одному chat_id.
      });
      const { pendingShowing, ...draftWithoutShowing } = draft;
      await prisma.telegramDirectConversation.update({
        where: { id: conversation.id },
        data: { clientId, leadDraft: { ...draftWithoutShowing, stage: "done" } as any },
      });
      if (pendingShowing) applyShowingRequestInBackground(clientId, pendingShowing, "TELEGRAM");
      // Досье и карточка — одна сущность (аудит audit-1, находка 11).
      if (conversation.contactProfileId) await linkContactProfileToClient(conversation.contactProfileId, clientId);
      /**
       * «ЗАЯВКА ПРИНЯТА» — ТЕМ ЖЕ КОДОМ, ЧТО В КАНАЛАХ META И ЛИЧКЕ БОТА
       * (03.10.2026, аудит audit-1, находки 4 и 15; messengers/leadAcceptedReply.ts):
       * для kind=OTHER — без обещания звонка, для обычной заявки — имя агента и
       * реальный срок звонка (ночью «завтра после 9:30»). Реплика клиента с номером
       * и ответ — в переписку.
       */
      if (saved.length === 0) await saveIncoming(historyText || phone);
      const closing = await leadAcceptedReply({
        kind: decision.kind,
        otherCity: isOtherCityReason(decision.reason),
        created,
        clientId,
        history,
        saidText: historyText || phone,
        clientWords,
        name: fullName,
        draft,
        conversationId: conversation.id,
        // Имя — из профиля Telegram; запасной номер этот канал не принимает.
        askName: false,
        askExtraPhones: false,
      });
      const acceptedReply = closing || inClientLanguage(FALLBACK_ACCEPTED, text, lastClientWords(history));
      await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: acceptedReply, by: { kind: "bot" } }]);
      await reply(acceptedReply);
    } catch (err) {
      console.error("[telegram-dm] createLeadFromChannel", err instanceof Error ? err.message : err);
      // Номер не теряется: реплика с ним ложится в переписку, а сам номер — в журнал
      // ошибок, откуда сотрудник заведёт карточку руками (ревизия бота 02.10.2026).
      if (saved.length === 0) await saveIncoming(historyText).catch(() => undefined);
      void logSystemError(
        "telegram",
        `Заявка из Telegram Direct Messages не оформлена (chat ${chatId}, topic ${topicId}, номер ${phone}): ${err instanceof Error ? err.message : String(err)}`,
        { url: `/messages` }
      );
      const failReply = inClientLanguage(NUMBER_SAVED_REPLY, clientWords);
      await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: failReply, by: { kind: "bot" } }]).catch(
        () => undefined
      );
      await reply(failReply);
    }
    return;
  }

  if (!text) {
    await saveIncoming(historyText);
    if (voiceNotUnderstood) {
      const voiceReply = inClientLanguage(FALLBACK_VOICE, lastClientWords(history));
      await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: voiceReply, by: { kind: "bot" } }]);
      await reply(voiceReply);
    }
    return;
  }

  const screen = screenIncomingText(text, {
    known: Boolean(conversation.clientId),
    jobConversation: draft.intent === "job",
  });
  if (screen.action === "silent") {
    await saveIncoming(`${historyText}\n${screen.mark}`.trim());
    return;
  }

  if (peerBudget) {
    if (peerBudget.budget.softJustExceeded) {
      void logSystemError(
        "ai",
        `Диалог ${conversation.id} (TELEGRAM Direct Messages) перешагнул обычную суточную норму ходов ИИ — ` +
          `бот продолжает работать, остановка только на аварийном потолке (lib/aiDailyBudget.ts)`
      );
    }
    if (peerBudget.budget.turnsLeft <= 0) {
      await saveIncoming(`${historyText}\n[⛔ суточный предел ходов ИИ — бот передал диалог агенту]`.trim());
      const notice = await noticeAiBudgetHandover(peerBudget.row, "TELEGRAM", conversation.username ?? null, detectClientLanguage(text));
      if (notice) {
        await appendDirectConversationMessages(conversation.id, [{ role: "assistant", content: notice, by: { kind: "bot" } }]);
        await reply(notice);
      }
      return;
    }
  }

  /**
   * ПРИСЛАННАЯ ССЫЛКА ЧИТАЕТСЯ И ЗДЕСЬ (21.09.2026, требование владельца «везде
   * одни и те же правила»). До этой правки обогащение ссылок жило ТОЛЬКО в
   * канале Meta: человек, приславший в Telegram ссылку на наш же объект или на
   * чужое объявление, получал ответ, будто ничего не присылал.
   *
   * Подсказка добавляется только к копии для модели: в переписку уходит `text`,
   * как и раньше (см. finishTurn выше).
   */
  const linkHint = await sharedMediaHint({ text, channel: "TELEGRAM", recipientId: String(topic.topic_id) });
  const nextHistory: ChatMessage[] = [
    ...history,
    { role: "user", content: linkHint ? `${text}\n${linkHint}` : text },
  ];
  await saveIncoming(historyText);

  /**
   * «ОК», ГОЛАЯ ПЕРЕСЫЛКА, ЕЩЁ ФОТО БЕЗ СЛОВ — БЕЗ ХОДА МОДЕЛИ (03.10.2026, аудит
   * audit-1, находка 8): те же отсечки, что в каналах Meta и личке бота
   * (messengers/replyChain.ts::silentTurnReason). На «Ок» — реакция 👍.
   */
  const silence = silentTurnReason({ text, hasMedia: saved.length > 0 || images.length > 0, history });
  if (silence) {
    if (silence === "ack_only" && msg.message_id != null) await setMessageReaction(chatId, msg.message_id, "👍");
    return;
  }

  // Окончание хода — общей функцией finishTelegramDirectQualifyTurn (объявлена
  // ниже в модуле), чтобы её же вызывал персистентный повтор
  // jobs/telegramDirectReplyRetry.ts. См. докстринг там же.
  const capabilities = await loadBotCapabilities();
  const finishTurn = (turn: NonNullable<Awaited<ReturnType<typeof runQualifyTurn>>>): Promise<void> =>
    finishTelegramDirectQualifyTurn({
      conversation,
      chatId,
      topicId: topic.topic_id,
      draft,
      history,
      text,
      turn,
      capabilities,
      incomingWasVoice: fetched.audios.length > 0,
      pausedUntilAtStart: conversation.pausedUntil,
    });

  const abilities = botAbilitiesOf(capabilities);
  if (peerBudget) await spendAiTurns(peerBudget.row.id, peerBudget.budget.dayKey, 1, "peer");
  const result = await runQualifyTurn(nextHistory, draft, {
    images,
    abilities,
    conversationId: conversation.id,
    contactProfile: await contactProfileForPrompt(conversation.contactProfileId, draft),
  });

  if (!result) {
    // Персистентный повтор (13.09.2026, тот же чертёж Б2, что у личных чатов и
    // каналов Meta) — см. докстринг jobs/telegramDirectReplyRetry.ts. dedupeKey
    // на диалог: пока задание ждёт/исполняется, повторные отказы модели по
    // тому же диалогу новых заданий не плодят.
    void enqueueBackgroundJob({
      type: "telegram-dm-reply-retry",
      payload: { conversationId: conversation.id },
      dedupeKey: `telegram-dm-reply-retry:${conversation.id}`,
      maxAttempts: AI_REPLY_RETRY_MAX_ATTEMPTS,
    });
    return;
  }

  await finishTurn(result);
}
