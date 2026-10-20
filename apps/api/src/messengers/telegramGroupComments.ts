import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { callAiText } from "../ai/client.js";
import { screenIncomingText } from "../ai/inboundScreen.js";
import { cleanOutgoingReply, isReactionOnly } from "../ai/replyGuards.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { sendPushToAgents } from "../push.js";
import { loadBotCapabilities } from "./botCapabilities.js";
import { isBotEnabledForChannel } from "./botChannels.js";
import { loadPeerAiBudget, spendAiTurns } from "../lib/aiDailyBudget.js";
import { SALES_FACTS } from "../ai/salesPlaybook.js";
import { companyInfoBlock } from "../ai/agencyFacts.js";
import { MANDATORY_BOT_RULES, propertyGeographyBlock } from "../ai/dushanbeGeography.js";
import { folkGeographyBlock } from "../ai/folkPlaces.js";
import {
  COMMENT_MODERATION_RULES,
  COMMENT_TONE_RULES,
  cleanPublicCommentReply,
  createLeadFromCompetitorAd,
  RUDE_EMOJI,
  stripShowingInvite,
  emojiThanksReply,
} from "./comments.js";
import { deleteChannelCommentMessage, sendMessage, type TelegramIncomingMessage } from "../telegram/api.js";
import { moderationErrorOutcome, moderationAcceptedNote } from "./commentModerationOutcome.js";
import { detectSpam } from "../lib/incomingSpam.js";
import { detectAgencyAd, detectListingAd } from "../lib/listingAd.js";
import { detectHate } from "../lib/commentHate.js";
import { resolveTelegramCommentProperty } from "../lib/propertyVoice/commentProperty.js";
import { commentDecisionProviderSchema, type CommentDecision } from "@royal-home/shared";
import { commentDecisionCapabilities, validateCommentDecision } from "../ai/commentDecision.js";

/**
 * Комментарии в группе-обсуждении Telegram-канала (01.09.2026).
 *
 * Тот же принцип, что у комментариев Instagram (messengers/comments.ts): приём
 * кладёт запись в очередь с паузой, крон раз в минуту отвечает. Сознательно
 * ПРОЩЕ инстаграмного собрата — не переносим сюда:
 *  - скрытия: в Telegram его нет вовсе, есть только удаление. До 24.09.2026 здесь
 *    не было и удаления («права бота не подтверждены»), и спам с чужими объявлениями
 *    оставался в группе на виду у всех. Теперь спам, объявления и то, что модель
 *    велит скрыть или удалить, бот удаляет (removeComment); нет у него права
 *    «Удалять сообщения» — комментарий закрывается пометкой, а в «Здоровье системы»
 *    раз в сутки пишется, какую галочку поставить;
 *  - dm/личное сообщение — у Instagram это отдельный API-вызов «в директ» тому же
 *    человеку; в Telegram написать незнакомцу первым нельзя вообще (бот пишет,
 *    только если человек сам начал переписку) — этому действию здесь неоткуда взяться;
 *  - воронку лид-магнита и привязку к карточке объекта (Property) — посты канала
 *    уже несут цену и район в собственной подписи (reelsCaption), отдельный
 *    поиск объекта по ссылке, как для Instagram, не нужен.
 */

/** Тот же порядок величины паузы, что у Instagram: мгновенный ответ выдаёт робота. */
const REPLY_DELAY_MIN_MS = 60_000;
const REPLY_DELAY_MAX_MS = 120_000;

const MAX_ATTEMPTS = 3;
const AI_DOWN_MAX_ATTEMPTS = 12;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const STUCK_AFTER_MS = 10 * 60 * 1000;
const BATCH_LIMIT = 30;
const MAX_TEXT = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Одному человеку под одним постом отвечаем не больше пяти раз в сутки — тот же
 *  предел и та же причина, что у Instagram (MAX_REPLIES_PER_AUTHOR_PER_MEDIA);
 *  поднято с 2 до 5 вместе с ним 17.09.2026. */
const MAX_REPLIES_PER_AUTHOR_PER_POST = 5;

// ─── Включена ли фича вообще ────────────────────────────────────────────────

interface GroupSettings {
  discussionGroupId: string | null;
}

async function loadGroupSettings(): Promise<GroupSettings> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramDiscussionGroupId: true },
  });
  return { discussionGroupId: settings?.telegramDiscussionGroupId ?? null };
}

const BOT_OFF_LOG_EVERY_MS = 24 * 60 * 60 * 1000;
let lastBotOffLogAt = 0;

/** Тот же общий ползунок «Отвечать на комментарии» (Настройки → Бот), что у
 *  Instagram — под постами это одно и то же поведение, разница только в канале. */
export async function isTelegramGroupCommentsEnabled(settings?: GroupSettings): Promise<boolean> {
  const s = settings ?? (await loadGroupSettings());
  if (!s.discussionGroupId) return false;
  if (!(await loadBotCapabilities()).comments) {
    const now = Date.now();
    if (now - lastBotOffLogAt >= BOT_OFF_LOG_EVERY_MS) {
      lastBotOffLogAt = now;
      void logSystemError(
        "telegram",
        "Группа-обсуждение Telegram-канала подключена, но общий ползунок «Отвечать на комментарии» " +
          "(Настройки → Бот) выключен — комментарии сохраняются, бот на них не отвечает."
      );
    }
    return false;
  }
  return isBotEnabledForChannel("TELEGRAM");
}

/**
 * Комментарий ли это под постом. Telegram зеркалит каждый пост канала в группу
 * отдельным сообщением (`is_automatic_forward: true`) — читатель отвечает на ЭТО
 * зеркало, а не на сам пост в канале (у них разные message_id). Обычная реплика
 * в группе БЕЗ такого reply_to_message — не комментарий к посту, а открытый чат:
 * бот в него сознательно не вступает, чтобы не превращаться в общего собеседника
 * группы, для которой антиспам и лимиты здесь не рассчитаны.
 */
/**
 * ОТВЕТ ВНУТРИ ВЕТКИ — ТОЖЕ КОММЕНТАРИЙ (18.09.2026).
 *
 * `reply_to_message.is_automatic_forward` узнаёт ТОЛЬКО первый комментарий под
 * постом: тот, кто отвечает на чужой комментарий — или на реплику самого бота, —
 * шлёт reply_to_message на этот комментарий, а не на зеркало поста, и такое
 * сообщение отбрасывалось молча. То есть продолжить разговор под постом Telegram
 * было нельзя вообще: бот отвечал один раз и на уточнение «а в каком районе?»
 * не отзывался никогда (лимит в 5 ответов на автора под постом при этом был
 * недостижим в принципе). В YouTube ровно такая же ветка работает, а личных
 * сообщений в группе нет — уточнять человеку больше негде.
 *
 * Признак ветки — `message_thread_id`: в группе-обсуждении Telegram ставит его
 * каждому комментарию и делает равным message_id зеркала поста, независимо от
 * того, на что именно человек ответил. Само зеркало исключаем сравнением с
 * message_id: у него они совпадают.
 *
 * Обычная реплика в открытом чате группы ветки не имеет, и бот в него по-прежнему
 * не вступает — смысл прежней проверки сохранён.
 */
export function isCommentUnderPost(msg: TelegramIncomingMessage): boolean {
  if (msg.is_automatic_forward) return false;
  if (msg.message_thread_id && msg.message_thread_id !== msg.message_id) return true;
  return Boolean(msg.reply_to_message?.is_automatic_forward);
}

/**
 * Под каким постом оставлен комментарий. Ветка (`message_thread_id`) вернее
 * reply_to_message: у ответа на чужой комментарий там лежит этот комментарий, а
 * не пост, и без ветки все они разошлись бы по разным «постам» — вместе с
 * лимитом ответов и подписью поста для промта.
 */
export function postMessageIdOf(msg: TelegramIncomingMessage): number | undefined {
  return msg.message_thread_id ?? msg.reply_to_message?.message_id;
}

/** Принимает комментарий в очередь. Дедуп — уникальная пара (groupChatId, messageId),
 *  как у Instagram commentId: повторная доставка апдейта (see webhookDedupe) не даст
 *  второй строки. message_id нумеруется внутри чата, поэтому одного messageId мало:
 *  после смены группы обсуждения комментарий новой группы с тем же номером — не дубль
 *  (CHANNEL-NEW-23, 04.10.2026). */
export async function ingestGroupComment(
  msg: TelegramIncomingMessage,
  groupChatId: string,
  enabled = true
): Promise<boolean> {
  if (String(msg.chat.id) !== groupChatId) return false;
  if (!isCommentUnderPost(msg)) return false;
  const messageId = msg.message_id;
  const postMessageId = postMessageIdOf(msg);
  const authorId = msg.from?.id;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!messageId || !postMessageId || !authorId || !text) return false;
  // Не человек со стороны (02.10.2026): ответ «от лица канала», анонимный админ,
  // другой бот или наш сотрудник. Раньше бот отвечал им под постом, как клиенту.
  if (msg.sender_chat || msg.from?.is_bot) return false;
  const staff = await prisma.agent.findFirst({ where: { telegramChatId: String(authorId) }, select: { id: true } });
  if (staff) return false;

  // Объект поста («голос рынка», 03.10.2026): по id исходного поста канала из
  // зеркала либо по соседнему комментарию ветки. Не нашли — комментарий принимается
  // как раньше, без объекта; сбой поиска ход приёма не меняет.
  const mirror = msg.reply_to_message?.is_automatic_forward ? msg.reply_to_message : undefined;
  const propertyId = await resolveTelegramCommentProperty({
    postMessageId: String(postMessageId),
    channelPostId: mirror?.forward_origin?.message_id ?? mirror?.forward_from_message_id ?? null,
  });

  try {
    // Строки, принятые до появления groupChatId (NULL): уникальный индекс их не видит,
    // поэтому повторную доставку такого комментария ловим здесь, по messageId.
    const legacyDuplicate = await prisma.telegramGroupComment.findFirst({
      where: { messageId: String(messageId), groupChatId: null },
      select: { id: true },
    });
    if (legacyDuplicate) return false;
    await prisma.telegramGroupComment.create({
      data: {
        messageId: String(messageId),
        groupChatId,
        postMessageId: String(postMessageId),
        ...(propertyId ? { propertyId } : {}),
        authorId: String(authorId),
        authorName: msg.from?.username ?? msg.from?.first_name ?? null,
        text: text.slice(0, MAX_TEXT),
        replyDueAt: new Date(Date.now() + REPLY_DELAY_MIN_MS + Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS)),
        // Бот выключен — строку всё равно пишем, но закрываем сразу: комментарий
        // обязан остаться в журнале, а отвечать на него потом, задним числом, уже
        // нельзя. Ровно тот же приём и та же пометка, что у Instagram/Facebook
        // (messengers/commentsQueue.ts::enqueueComments), и именно её обещает
        // схема (schema.prisma: note "bot_off").
        ...(enabled ? {} : { status: "SKIPPED", note: "bot_off" }),
      },
    });
    return true;
  } catch (err) {
    // P2002 (пара группа + messageId уже есть) — обычная повторная доставка, не ошибка.
    if ((err as { code?: string }).code === "P2002") return false;
    void logSystemError("telegram", `Комментарий группы-обсуждения не принят: ${describeError(err)}`);
    return false;
  }
}

// ─── Решение модели ─────────────────────────────────────────────────────────

const LANGUAGE_RULES =
  "ЯЗЫК: отвечай СТРОГО на языке комментария. Таджикский — таджикской кириллицей, русский — по-русски, " +
  "английский — по-английски, узбекский — по-узбекски. Переходить на другой язык запрещено.\n" +
  "Пиши так, как говорит живой риелтор в Душанбе: простые обиходные слова, короткие фразы. Книжные и " +
  "канцелярские обороты ЗАПРЕЩЕНЫ.\n";

/** Системный промт. В отличие от Instagram — без hide/delete/dm (см. докстринг файла)
 *  и без ветки «объект известен/неизвестен»: у Telegram-поста нет карточки CRM,
 *  за него отвечает собственная подпись пересланного поста. */
function buildTelegramCommentSystem(postText: string, answered: number): string {
  const greetingLine =
    answered > 0
      ? "ЭТОМУ ЧЕЛОВЕКУ МЫ УЖЕ ОТВЕЧАЛИ под этим постом. Здороваться повторно ЗАПРЕЩЕНО.\n"
      : "Этому человеку под этим постом мы ещё не отвечали — можно один раз коротко поздороваться.\n";
  return (
    "Ты — консультант агентства недвижимости Royal Home в Душанбе и отвечаешь на комментарии в группе-обсуждении " +
    "нашего Telegram-канала. Сам себя ИИ не называй; на прямой вопрос «ты бот?» честно подтверди одной фразой и продолжай по делу.\n" +
    "Публичный ответ читают посторонние: он короткий (одна-две фразы), доброжелательный, без тире «—», " +
    "без хештегов и без гирлянды эмодзи. Ничего не выдумывай: цена, площадь, район и наличие — только из подписи " +
    "поста ниже.\n\n" +
    LANGUAGE_RULES +
    // Тот же тон, что под постами Instagram/Facebook/YouTube (02.10.2026): одно место.
    COMMENT_TONE_RULES.replace(/📩 рядом с «директ», /, "") +
    "\n" +
    greetingLine +
    "\n" +
    `Подпись поста, под которым оставлен комментарий: «${postText.slice(0, 600) || "подписи нет"}».\n` +
    "Отвечай по существу из этой подписи: спросили цену или район — назови их прямо, без «напишите нам». " +
    "Если в подписи нет того, о чём спросили (документы, торг, показ) — коротко позови написать боту в личку " +
    "(@royalhometj_bot), не выдумывая цифр.\n" +
    "Звать смотреть квартиру в первом же ответе не нужно — только если человек сам заговорил о показе.\n\n" +
    // Правила модерации — те же, что под постами Instagram/Facebook/YouTube (24.09.2026):
    // одно место, иначе спам и чужие объявления снова разойдутся по площадкам.
    "Как выбрать action: reply — вопрос или отклик по делу; escalate — не знаешь ответа; ignore — отвечать не на что.\n" +
    COMMENT_MODERATION_RULES +
    "В этой группе скрыть сообщение нельзя: и hide, и delete удаляют его. Написать собственнику в личку первыми " +
    "мы здесь не можем: если он спросил нас, в reply позови его написать нашему боту @royalhometj_bot.\n"
  );
}

async function decideOnComment(text: string, postText: string, answered: number): Promise<CommentDecision | null> {
  const capabilities = commentDecisionCapabilities("TELEGRAM");
  const decision = await callAiText<unknown>({
    endpoint: "telegram-comment",
    systemStable: companyInfoBlock() + SALES_FACTS + (await folkGeographyBlock()) + MANDATORY_BOT_RULES + (await propertyGeographyBlock()),
    system: buildTelegramCommentSystem(postText, answered),
    user: `Комментарий: «${text}»`,
    maxTokens: 400,
    // Ответ читают посторонние — как и в Instagram, экономить на качестве нельзя.
    effort: "high",
    schema: commentDecisionProviderSchema(capabilities),
  });
  return validateCommentDecision(decision, capabilities, "telegram-comment");
}

// ─── Разбор очереди ─────────────────────────────────────────────────────────

export interface TelegramCommentRunStats {
  replied: number;
  hidden: number;
  escalated: number;
  skipped: number;
}

type QueuedComment = {
  id: string;
  messageId: string;
  /** Группа, из которой пришёл комментарий; null у строк, принятых до этого поля. */
  groupChatId?: string | null;
  postMessageId: string;
  authorId: string;
  authorName: string | null;
  text: string;
  status: string;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function processDueTelegramComments(now: Date = new Date()): Promise<TelegramCommentRunStats> {
  const stats: TelegramCommentRunStats = { replied: 0, hidden: 0, escalated: 0, skipped: 0 };
  const settings = await loadGroupSettings();
  if (!(await isTelegramGroupCommentsEnabled(settings)) || !settings.discussionGroupId) {
    /**
     * ВЫКЛЮЧЕНО — ОЧЕРЕДЬ ЗАКРЫВАЕМ, А НЕ КОПИМ (18.09.2026).
     *
     * Прежний голый `return` оставлял подошедшие строки в PENDING навсегда, и при
     * обратном включении бот отвечал на комментарии, которым уже несколько дней, —
     * как будто они пришли только что. Закрываем той же пометкой, что ставит приём
     * (см. ingestGroupComment) и что делает Instagram у себя в разборе:
     * «отвечать задним числом нельзя», но запись в журнале остаётся.
     */
    const closed = await prisma.telegramGroupComment.updateMany({
      where: { status: "PENDING", replyDueAt: { lte: now } },
      data: { status: "SKIPPED", note: "bot_off" },
    });
    stats.skipped += closed.count;
    return stats;
  }

  const due = (await prisma.telegramGroupComment.findMany({
    where: {
      OR: [
        { status: "PENDING", replyDueAt: { lte: now } },
        { status: "WORKING", updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) }, attempts: { lt: AI_DOWN_MAX_ATTEMPTS } },
      ],
    },
    orderBy: { replyDueAt: "asc" },
    take: BATCH_LIMIT,
  })) as QueuedComment[];

  for (const row of due) {
    const claimed = await prisma.telegramGroupComment.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: "WORKING", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    // Группу обсуждения сменили, а строка пришла из прежней: отвечать и удалять в ней
    // нельзя (номер сообщения чужой для новой группы, прежняя группа больше не наша).
    // Закрываем с пометкой, запись остаётся в журнале (CHANNEL-NEW-23).
    if (row.groupChatId && row.groupChatId !== settings.discussionGroupId) {
      await finish(row.id, { status: "SKIPPED", note: "group_changed" });
      stats.skipped++;
      continue;
    }

    try {
      const outcome = await handleTelegramComment(row, settings.discussionGroupId);
      stats[outcome]++;
    } catch (err) {
      await failComment(row, err);
    }
  }
  return stats;
}

async function finish(id: string, data: Record<string, unknown>): Promise<void> {
  await prisma.telegramGroupComment.update({ where: { id }, data });
}

class AiUnavailableError extends Error {}

export async function handleTelegramComment(
  row: QueuedComment,
  currentGroupChatId: string
): Promise<keyof TelegramCommentRunStats> {
  // Отвечаем и удаляем в той группе, откуда пришёл комментарий: его message_id имеет
  // смысл только там. Строки без группы (до CHANNEL-NEW-23) — в текущую, как раньше.
  const groupChatId = row.groupChatId ?? currentGroupChatId;
  const answered = await prisma.telegramGroupComment.count({
    where: {
      authorId: row.authorId,
      postMessageId: row.postMessageId,
      status: "REPLIED",
      repliedAt: { gte: new Date(Date.now() - DAY_MS) },
    },
  });
  if (answered >= MAX_REPLIES_PER_AUTHOR_PER_POST) {
    await finish(row.id, { status: "SKIPPED", note: "loop_guard" });
    return "skipped";
  }

  if (isReactionOnly(row.text) && !RUDE_EMOJI.test(row.text)) {
    const reply = emojiThanksReply(row.messageId);
    await sendMessage(groupChatId, reply, Number(row.messageId));
    await finish(row.id, { status: "REPLIED", replyText: reply, repliedAt: new Date() });
    return "replied";
  }

  // Явный спам/оскорбление под нашим постом: бот молчит (удалять/скрывать не
  // умеет без подтверждённых прав — см. докстринг файла), а не отвечает всерьёз.
  if (RUDE_EMOJI.test(row.text)) {
    await finish(row.id, { status: "SKIPPED", note: "rude" });
    return "skipped";
  }

  const screen = screenIncomingText(row.text, { checkSpam: false });
  if (screen.action === "silent") {
    await finish(row.id, { status: "SKIPPED", note: screen.reason.slice(0, 120) });
    return "skipped";
  }

  /**
   * СПАМ И ЧАСТНЫЕ ОБЪЯВЛЕНИЯ — КОДОМ, КАК ПОД ПОСТАМИ INSTAGRAM (24.09.2026).
   *
   * Здесь не было ни того, ни другого: `checkSpam: false` выше без запасной
   * проверки, как в messengers/comments.ts, и ни слова про чужие объявления в
   * промте. «Продаю, 58 м², 15 этаж, звоните» висело в обсуждении открытым, а
   * номер из него никуда не ложился. Тот же словарь спама (lib/incomingSpam.ts), та
   * же отсечка объявлений (lib/listingAd.ts), та же карточка по номеру.
   */
  const obviousSpam = detectSpam(row.text, { comment: true });
  if (obviousSpam) {
    return removeComment(row, groupChatId, `spam: ${obviousSpam.reason}`);
  }
  const hate = detectHate(row.text);
  if (hate) return removeComment(row, groupChatId, hate.reason);
  const agencyAd = detectAgencyAd(row.text);
  if (agencyAd) {
    const outcome = await removeComment(row, groupChatId, agencyAd.reason);
    await leadFromAd(row, "OTHER");
    return outcome;
  }
  // Собственник. Написать ему первым в Telegram бот не может (личку начинает только
  // человек), поэтому «обработать разговором», как в Instagram, здесь нельзя: номер
  // сразу ложится карточкой «Продавец», и обрабатывает его агент звонком.
  const listingAd = detectListingAd(row.text);
  if (listingAd) {
    const outcome = await removeComment(row, groupChatId, listingAd.reason);
    await leadFromAd(row, "SELLER");
    return outcome;
  }

  const { row: budgetRow, budget } = await loadPeerAiBudget("TELEGRAM_COMMENTS", row.authorId, null);
  if (budget.turnsLeft <= 0) {
    void logSystemError(
      "ai",
      `Комментатор ${row.authorName ? `@${row.authorName}` : row.authorId} упёрся в суточный потолок ходов ИИ ` +
        `под постами Telegram — бот больше не отвечает ему сегодня.`
    );
    await finish(row.id, { status: "SKIPPED", note: "ai_budget" });
    return "skipped";
  }

  /**
   * ПОДПИСИ ПОСТА У НАС НЕТ — И ВЫДАВАТЬ ЗА НЕЁ ЧУЖОЙ КОММЕНТАРИЙ НЕЛЬЗЯ
   * (18.09.2026).
   *
   * Здесь стоял `telegramGroupComment.findFirst({ where: { postMessageId } })`, и
   * его результат уходил в промт строкой «Подпись поста» (см. decideOnComment).
   * Но в этой таблице лежат только КОММЕНТАРИИ: сам пост в неё не попадает
   * никогда (зеркало отсекает isCommentUnderPost). То есть модели как подпись
   * поста подавался текст случайного комментария под ним — без orderBy чаще всего
   * своего же, а под спамной веткой и вовсе реклама конкурента. На такой «подписи»
   * законный вопрос «нарх чанд?» модель закрывает как ignore, и это ровно те
   * молчаливые пропуски, из-за которых правка и делается.
   *
   * Пустая строка честнее: промт уже умеет работать без подписи. Настоящий текст
   * поста лежит в апдейте (`reply_to_message` у корневого комментария — это
   * зеркало поста), но хранить его негде: в TelegramGroupComment нет такой
   * колонки. Отдельной задачей с миграцией — см. docs/TASKS.md.
   */
  await spendAiTurns(budgetRow.id, budget.dayKey, 1, "peer");
  const decision = await decideOnComment(row.text, "", answered);
  if (!decision) throw new AiUnavailableError("Модель не вернула решение по комментарию Telegram");

  if (decision.action === "owner") {
    // Спросил НАС — короткий ответ со ссылкой на бота остаётся под постом; выложил
    // объявление для читателей — оно уходит. Номер, если есть, — карточкой «Продавец».
    await leadFromAd(row, "SELLER");
    const ownerReply = decision.reply?.trim() ? cleanOutgoingReply(decision.reply, row.text, { allowOneEmoji: false }) : "";
    if (!ownerReply.trim()) return removeComment(row, groupChatId, "owner");
    await sendMessage(groupChatId, ownerReply, Number(row.messageId));
    await finish(row.id, { status: "REPLIED", note: "owner", replyText: ownerReply, repliedAt: new Date() });
    return "replied";
  }

  if (decision.action === "hide" || decision.action === "delete") {
    const outcome = await removeComment(
      row,
      groupChatId,
      decision.action === "delete" ? "competitor_ad" : "spam"
    );
    if (decision.action === "delete") await leadFromAd(row, "OTHER");
    return outcome;
  }

  if (decision.action === "escalate") {
    await escalate(row, decision.reason);
    await finish(row.id, { status: "ESCALATED", note: decision.reason?.slice(0, 200) });
    return "escalated";
  }

  if (decision.action === "ignore" || !decision.reply?.trim()) {
    await finish(row.id, { status: "SKIPPED", note: "ignore" });
    return "skipped";
  }

  const cleaned = stripShowingInvite(cleanPublicCommentReply(decision.reply, row.text));
  if (!cleaned.trim()) {
    await finish(row.id, { status: "SKIPPED", note: "empty_after_clean" });
    return "skipped";
  }
  await sendMessage(groupChatId, cleaned, Number(row.messageId));
  await finish(row.id, { status: "REPLIED", replyText: cleaned, repliedAt: new Date() });
  return "replied";
}

const NO_RIGHTS_LOG_EVERY_MS = 24 * 60 * 60 * 1000;
let lastNoRightsLogAt = 0;

/**
 * Убрать комментарий из обсуждения. Скрытия в Telegram нет — только удаление, и
 * только если бот в группе администратор с правом «Удалять сообщения».
 *
 * Нет права — не повторяем трижды и не зовём человека: повтор не поможет, пока
 * владелец не поставит галочку. Запись закрывается пометкой, а в «Здоровье
 * системы» раз в сутки уходит, что именно сделать.
 */
async function removeComment(
  row: QueuedComment,
  groupChatId: string,
  note: string
): Promise<keyof TelegramCommentRunStats> {
  try {
    await deleteChannelCommentMessage(groupChatId, Number(row.messageId));
  } catch (err) {
    const text = describeError(err);
    if (/message to delete not found/i.test(text)) {
      await finish(row.id, { status: "FAILED", note: "gone" });
      return "skipped";
    }
    if (/can't be deleted|not enough rights|need administrator rights|CHAT_ADMIN_REQUIRED|have no rights/i.test(text)) {
      const now = Date.now();
      if (now - lastNoRightsLogAt >= NO_RIGHTS_LOG_EVERY_MS) {
        lastNoRightsLogAt = now;
        void logSystemError(
          "telegram",
          "Бот не может удалить спам в группе-обсуждении Telegram-канала: у него нет права. Откройте группу → " +
            "Управление группой → Администраторы → бот → включите «Удалять сообщения». Ответ Telegram: " +
            text.slice(0, 200)
        );
      }
      await finish(row.id, { status: "SKIPPED", note: `cant_delete: ${note}`.slice(0, 120) });
      return "skipped";
    }
    const result = moderationErrorOutcome("TELEGRAM", "delete", err);
    void logSystemError("telegram", `Удаление комментария ${row.messageId} не подтверждено: ${result.reason}`);
    await finish(row.id, { status: "SKIPPED", note: `moderation_unknown; ${note}`.slice(0, 200) });
    return "skipped";
  }
  await finish(row.id, { status: "DELETED", note: moderationAcceptedNote(
    { provider: "TELEGRAM", effect: "delete", outcome: "accepted", reason: "provider_confirmed" }, note) });
  return "hidden";
}

/** Номер из объявления — в карточку тем же путём, что под постами Instagram. */
async function leadFromAd(row: QueuedComment, kind: "OTHER" | "SELLER"): Promise<void> {
  await createLeadFromCompetitorAd(
    { channel: "TELEGRAM", authorName: row.authorName, text: row.text, commentId: row.messageId },
    kind
  ).catch((err) =>
    logSystemError("telegram", `Объявление в обсуждении ${row.messageId}: карточка по номеру не заведена: ${describeError(err)}`)
  );
}

async function escalate(row: QueuedComment, reason?: string): Promise<void> {
  try {
    const recipients = await findAgentsWithPermission("messages.view");
    const author = row.authorName ? `@${row.authorName}` : "Читатель";
    const body = `${author}: «${row.text.slice(0, 120)}»${reason ? ` — ${reason.slice(0, 120)}` : ""}`;
    // Один запрос на всех получателей разом (22.09.2026, тот же класс, что в
    // messengers/comments.ts) вместо sendPushToAgent на каждого.
    await sendPushToAgents(recipients, {
      title: "💬 Telegram: бот не знает ответа",
      body,
      url: "/messages",
      tag: `tg-comment-${row.messageId}`,
    });
  } catch (err) {
    void logSystemError("telegram", `Эскалация комментария Telegram не доставлена: ${describeError(err)}`);
  }
}

async function failComment(row: QueuedComment, err: unknown): Promise<void> {
  void logSystemError("telegram", `Комментарий группы-обсуждения ${row.messageId} не обработан: ${describeError(err)}`);
  const attempts = row.attempts + 1;

  if (err instanceof AiUnavailableError) {
    if (attempts >= AI_DOWN_MAX_ATTEMPTS) {
      await finish(row.id, { status: "FAILED", note: "ai_down" });
      return;
    }
    const delayMs = Math.min(RETRY_DELAY_MS * 2 ** (attempts - 1), 4 * 60 * 60 * 1000);
    await finish(row.id, { status: "PENDING", replyDueAt: new Date(Date.now() + delayMs) });
    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    await finish(row.id, { status: "FAILED", note: "no_answer" });
    return;
  }
  await finish(row.id, { status: "PENDING", replyDueAt: new Date(Date.now() + RETRY_DELAY_MS) });
}
