import { prepareCustomerPublicAgentDraft, publicAgentCommentLane, finishPublicAgentDecision } from "../lib/customerPublicAgentTurn.js";
import { expireUnsentPublicAgentPlans } from "../lib/customerPublicAgentFailure.js";
import { inspectPublicCommentPrincipal } from "../lib/publicCommentSourceIssuer.js";
import { withCustomerPublicDeliveryTrace } from "../lib/customerAgentDeliveryTrace.js";
import { readPublicCommentMetaToken } from "../lib/customerPublicCommentStore.js";
import { createCustomerPublicReplyStore, publicCommentWireTarget } from "../lib/customerPublicDelivery.js";
import { PublicReplyHeldError, sendRecordedPublicReply } from "./publicCommentReply.js";
import { prisma } from "../db.js";
import { detectSpam } from "../lib/incomingSpam.js";
import { detectAgencyAd, detectListingAd, looksTajik } from "../lib/listingAd.js";
import { executeCustomerPublicModeration } from "../lib/customerPublicModeration.js";
import { detectHate } from "../lib/commentHate.js";
import { describeBuyerMatch, matchBuyersForListing, OWNER_NOTE_PREFIX } from "../lib/ownerBuyerMatch.js";
import { logSystemError } from "../lib/systemError.js";
import { logTimeline } from "../lib/timeline.js";
import { recordInterest } from "../lib/propertyInterest.js";
import { cleanOutgoingReply, isReactionOnly, stripMachineTypography } from "../ai/replyGuards.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { sendPushToAgents } from "../push.js";
import { callAiText } from "../ai/client.js";
import { learnedRulesBlock } from "../lib/botLessons.js";
import { screenIncomingText } from "../ai/inboundScreen.js";
import { siteListingUrl } from "../lib/siteListingUrl.js";
import { captionShortId, describeProperty, healInstagramUrl, instagramShortcode, recordClientInterest } from "./sharedMedia.js";
import {
  callGraph,
  describeError,
  fetchWithRetry,
  GRAPH_VERSION,
  instagramApiUrl,
  instagramRequest,
  loadCredentials,
  sendPrivateReply,
} from "./meta.js";
import type { MessengerChannel } from "./turnTypes.js";
import { loadBotCapabilities } from "./botCapabilities.js";
import {
  hasPendingLeadMagnetDelivery,
  isFunnelKeyword,
  leadMagnetActive,
  tryLeadMagnetComment,
} from "../lib/leadMagnet.js";
import { loadPeerAiBudget, spendAiTurns } from "../lib/aiDailyBudget.js";
import { resolveIncomingAccount } from "./accounts.js";
import { ensureConversationId } from "./conversationStore.js";
import { propertyIdForStoredComment } from "../lib/propertyVoice/commentProperty.js";
import { appendConversationMessages } from "./appendMessages.js";
import { SALES_FACTS } from "../ai/salesPlaybook.js";
import { MANDATORY_BOT_RULES, propertyGeographyBlock } from "../ai/dushanbeGeography.js";
import { folkGeographyBlock } from "../ai/folkPlaces.js";
import { AGENCY_COMPANY_INFO } from "../ai/agencyVoice.js";
import { extractAllPhones } from "../lib/shared/phoneText.js";
import { createLeadFromChannel } from "../services/leads/intake.js";
import { findPhoneOwners } from "../lib/clientPhones.js";
import { commentDecisionProviderSchema, type ClientSource, type CommentDecision } from "@royal-home/shared";
import { commentDecisionCapabilities, validateCommentDecision } from "../ai/commentDecision.js";
import { sleep } from "./humanPacing.js";
import {
  graphModerationOutcome, requireModerationAccepted, moderationErrorOutcome,
  moderationFailureNote, moderationAcceptedNote, type ModerationOutcome, type ModerationProvider,
} from "./commentModerationOutcome.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { commentApi, isCommentGone, postCommentReply, postCommentReplyResponse, setCommentHidden } from "./commentGraphActions.js";
export { isCommentGone, postCommentReply, postCommentReplyResponse, setCommentHidden };
import { ingestInstagramComments, ingestManagedMetaPublicComments, isCommentsBotEnabled, parseIncomingComments } from "./commentIngest.js";
export { ingestInstagramComments, ingestManagedMetaPublicComments, parseIncomingComments };
import {
  deleteYouTubeComment,
  fetchYouTubeVideoInfo,
} from "./youtubeComments.js";

/**
 * Комментарии под публикациями Instagram: ответ, личное сообщение, модерация.
 *
 * Комментарии приходят тем же вебхуком, что и переписка (entry[].changes[] с
 * field "comments"), но живут по другим правилам, и поэтому вынесены сюда, а не
 * дописаны в общий разбор:
 *
 *  - их читают посторонние, поэтому промах виден всему городу, а спам и
 *    оскорбления надо убирать с глаз, а не отвечать на них;
 *  - мгновенный ответ под постом — главный признак робота, поэтому отвечаем
 *    через 1-2 минуты; значит нужна очередь, а не обработка прямо в вебхуке;
 *  - Meta доставляет одно и то же событие повторно, а второй ответ на тот же
 *    комментарий виден всем, поэтому идемпотентность здесь обязана держаться на
 *    ограничении базы (уникальный commentId), а не на аккуратности кода.
 *
 * Весь путь комментария: вебхук кладёт запись в очередь (`ingestInstagramComments`),
 * крон раз в минуту разбирает подошедшие (`processDueComments`).
 */

/** Пауза перед ПУБЛИКАЦИЕЙ текста под постом (см. humanReplyDelay) — не перед
 *  решением, что с комментарием делать. До 05.09.2026 держала весь разбор, включая
 *  hide/delete; теперь только момент, когда бот говорит от своего имени публично. */
const REPLY_DELAY_MIN_MS = 60_000;
const REPLY_DELAY_MAX_MS = 120_000;

/**
 * Пауза перед тем, как бот заговорит под постом от своего имени — обычный ответ
 * и одиночная реакция-смайлик (isReactionOnly). hide/delete/ignore ничего не
 * публикуют и эту функцию не вызывают вовсе — им незачем ждать.
 *
 * Воронка лид-магнита (tryLeadMagnetComment, lm_author_nudged) — намеренное
 * исключение: пауза там уже проверена и отвергнута отдельным решением владельца
 * 16.08.2026 («жду две минуты — ни ответа, ни файла»), эту функцию она не вызывает.
 *
 * `sleep` — из messengers/humanPacing.ts, а не свой таймер: та же пауза, что держит
 * переписку в директе человечной, и тот же путь для теста подменить её на мгновенную
 * (см. tests/instagram-comments.test.ts, vi.mock humanPacing.js).
 */
async function humanReplyDelay(): Promise<void> {
  await sleep(REPLY_DELAY_MIN_MS + Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS));
}

/**
 * Сколько комментариев разбираем одновременно за один тик крона (заведено
 * 05.09.2026 вместе с переносом паузы на публикацию). Публичный ответ теперь ждёт
 * humanReplyDelay ПЕРЕД отправкой, и при последовательном разборе спам-комментарий,
 * вставший в очередь следом за обычным ответом, ждал бы эту чужую паузу впустую —
 * ровно то, чего просил избежать владелец. Предел, а не Promise.all без границы:
 * тик может разбирать вирусный всплеск (см. BATCH_LIMIT), и залп сразу по всем в
 * Graph API и к ИИ — источник собственных отказов по лимитам поставщиков.
 */
const COMMENT_CONCURRENCY = 8;

/** Личное сообщение по комментарию Meta разрешает только 7 суток — дальше запрос
 *  отвергается, и пытаться незачем. */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Одному человеку под одной публикацией отвечаем не больше пяти раз в сутки.
 *  Комментатор, которому бот отвечает бесконечно, — это и есть зацикливание,
 *  видимое всей ленте. Дальше разговор переносит живой человек.
 *  Было 2 — поднято до 5 по решению владельца 17.09.2026: человек с тремя-четырьмя
 *  вопросами подряд оставался без ответа, а в YouTube переписки в личке нет вовсе,
 *  разговор идёт только под роликом. */
const MAX_REPLIES_PER_AUTHOR_PER_MEDIA = 5;

/** С какого числа комментариев за 2 часа под НЕПРИВЯЗАННЫМ постом бьём тревогу
 *  (см. комментарий у места использования). Ниже — шум от органичных постов,
 *  под рекламой всплеск заметно больше и быстрее. */
const UNBOUND_AD_ALERT_THRESHOLD = 4;

/**
 * Ответ на комментарий из одних смайликов: благодарность и одно сердечко.
 *
 * Ровно два знака, а не гирлянда: стена эмодзи под собственным постом читается как
 * накрутка. Цвет сердечка разный у разных комментариев — владелец просил, чтобы
 * ответы не выглядели под постом одинаковой копией.
 *
 * Цвет выбирается ИЗ ИДЕНТИФИКАТОРА комментария, а не случайно: то же решение, что
 * у разброса напоминаний (lib/botFollowUps.ts). Случайность здесь означала бы, что
 * поведение не воспроизводится в тестах и меняется при повторной обработке той же
 * записи после сбоя.
 */
const HEARTS = ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "🩷"];

/** Смайлики, которые значат не восторг, а грубость: на них отвечает не автомат,
 *  а модель — она умеет скрыть такой комментарий от подписчиков. */
/**
 * ПЕРЕЧИСЛЕНИЕМ, А НЕ КВАДРАТНЫМИ СКОБКАМИ (найдено тестом 22.08.2026).
 *
 * `☠️` состоит из ДВУХ символов: знака и модификатора начертания U+FE0F. В
 * квадратных скобках модификатор становился отдельным членом списка — а он стоит
 * в конце почти каждого цветного смайлика. Значит «грубым» считался, например,
 * комментарий «Раҳмат ❤️», и такого человека воронка молча пропускала как
 * враждебного. Перечисление через `|` сравнивает последовательности целиком.
 */
export const RUDE_EMOJI = /🖕|💩|🤮|🤢|🤡|👿|😡|🤬|💀|☠️|🙄/u;

/**
 * Приглашение приехать на показ — вычёркивается из ПУБЛИЧНОГО ответа.
 *
 * Правило стоит и в промте, но промт здесь просьба: ровно это правило («ответь
 * смайликом на смайлик») модель проигнорировала 37 раз подряд, и полагаться на неё
 * второй раз нельзя. Под постом ответ обязан отвечать на вопрос и заканчиваться:
 * зазывание читают посторонние, и выглядит оно рекламой, а не ответом.
 *
 * Режем ПРЕДЛОЖЕНИЕ ЦЕЛИКОМ, а не слово: обрубок «Нархаш 123 000$. Кай бароятон» был
 * бы хуже самого приглашения. Границы предложения — точка, вопросительный и
 * восклицательный знак; если приглашение оказалось единственной фразой, остаётся
 * пустая строка, и вызывающий обязан такой ответ не публиковать.
 *
 * Личных сообщений НЕ касается: там приглашение уместно, когда человек сам заговорил
 * о просмотре, и решает это модель по смыслу разговора.
 */
// ВНИМАНИЕ: `\w` в JavaScript — это [A-Za-z0-9_], кириллицу он НЕ включает, и
// /приход\w*/ не находит «приходите» вовсе. В этом репозитории так молча умирали
// уже три правила (стоп-слова напоминаний, определение непонимания, и это).
// Поэтому хвост слова — `\S*`, а не `\w*`.
const INVITE_PATTERNS = [
  /омада\s+бин/i,
  /биёед\s+бин/i,
  /тамошо\s+кар/i,
  /приход\S*\s+(по)?смотр/i,
  /приезж\S*\s+(по)?смотр/i,
  /приглаша\S*\s+(на\s+)?(показ|просмотр)/i,
  /(когда|кай)\s+\S*\s*(удобно|қулай)\S*\s+(приехать|омад)/i,
];

export function stripShowingInvite(text: string): string {
  // Границей считается и перевод строки, а не только точка. Модель регулярно
  // разделяет фразы переносом («Нархаш 320 000\nОмада бинед»), и при разбиении
  // только по точке весь ответ оказывался ОДНИМ предложением — совпадение с
  // приглашением выбрасывало его целиком, комментарий оставался без ответа. Ровно
  // то, против чего эта правка и вводилась.
  const sentences = text.split(/(?<=[.!?])[ \t]+|\n+/);
  const kept = sentences.filter((s) => s.trim() && !INVITE_PATTERNS.some((p) => p.test(s)));
  return kept.join(" ").replace(/[ \t]{2,}/g, " ").trim();
}

export function emojiThanksReply(commentId: string): string {
  let hash = 0;
  for (const ch of commentId) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return `🙏${HEARTS[hash % HEARTS.length]}`;
}

/**
 * ОДИН смайлик того же семейства — для настоящей реакции (WhatsApp/Telegram),
 * а не текстового сообщения. Реакция принимает ровно один эмодзи, «🙏❤️» из
 * emojiThanksReply туда не годится.
 */
export function reactionHeart(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return HEARTS[hash % HEARTS.length];
}

/** Предел выборки крона: очередь может распухнуть после вирусного поста, но один
 *  проход обязан заканчиваться за разумное время.
 *  Снижено 30 → 16 (22.09.2026): каждый комментарий с публичным ответом ждёт
 *  humanReplyDelay (60-120с) ПЕРЕД публикацией внутри самого тика (мгновенный
 *  ответ выдаёт робота), а обрабатываются они волнами по COMMENT_CONCURRENCY=8 —
 *  при 30 в очереди тик почти гарантированно не укладывался даже в увеличенный
 *  таймаут крона (см. cron.ts, timeoutMs у "instagram-comments"). 16 держит
 *  волн не больше двух; остаток очереди не теряется — следующий тик (через
 *  минуту) подхватит его по replyDueAt. */
const BATCH_LIMIT = 16;

/** Сколько раз пробуем обработать комментарий, прежде чем позвать человека. */
const MAX_ATTEMPTS = 3;
/** Потолок попыток при НЕДОСТУПНОМ ИИ — терпеливее обычного: с растущей паузой
 *  (5м → 4ч) двенадцать попыток покрывают больше суток. Владелец 16.08.2026:
 *  «вопросы не должны исчезать — бот пусть позже, но ответит». */
const AI_DOWN_MAX_ATTEMPTS = 12;
const RETRY_DELAY_MS = 5 * 60 * 1000;

/** Запись, застрявшая в WORKING (процесс упал посреди обработки), должна вернуться
 *  в очередь, а не пропасть навсегда. */
const STUCK_AFTER_MS = 10 * 60 * 1000;

// MAX_TEXT (обрезка текста при записи) переехал в commentsQueue.ts вместе с
// enqueueComments — второго места, где строится строка очереди, больше нет.

// ─── Разбор вебхука ─────────────────────────────────────────────────────────

// IncomingComment живёт в commentsQueue.ts (импортирован выше) — общая форма строки
// очереди, читаемая и YouTube-поллером, и этим файлом.


// ─── Что мы знаем о публикации ──────────────────────────────────────────────

export interface MediaContext {
  permalink?: string;
  caption?: string;
  property?: {
    id: string;
    shortId: number;
    /** Хозяин объекта; в тестовых и YouTube-контекстах может не прийти. */
    intakeAgentId?: string | null;
    assignedAgentId?: string | null;
    createdById?: string | null;
    rooms: number | null;
    type: string;
    areaSqm: unknown;
    price: unknown;
    currency: string;
    status: string;
    /** Новостройка/вторичка/котлован — владелец 17.09.2026: «как это мы не знаем,
     *  новостройка или нет?». Единственное поле в базе, отвечающее на этот вопрос
     *  (condition — про состояние ремонта, а не возраст дома). Может быть не
     *  заполнено на старых карточках — тогда просто не упоминаем его в ответе. */
    marketType: string | null;
    // Закрытый объект (offSite) может остаться без района вовсе — маловероятно
    // для объекта со ссылкой на Reels (видео он не проходит), но тип честный.
    district: { name: string } | null;
    /** Нужны, чтобы собрать ссылку на объект тем же способом, что и в переписке
     *  (lib/siteListingUrl.ts). Свой формат адреса здесь заводить нельзя: две
     *  разные ссылки на один объект — это две разные страницы для клиента. */
    publishedOnSite: boolean;
    siteListingId: number | null;
  };
  /**
   * ПОДБОРКА ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests) — публикация
   * найдена в SocialDigestPost, а не привязана к ОДНОМУ объекту (`property`
   * выше). Решение по умолчанию (задание §6, «если трудоёмко — минимум»):
   * список номеров без полных карточек — знакомить бота с ценой/районом
   * каждого из пяти объектов ради одного комментария под подборкой избыточно;
   * бот называет номера и зовёт в директ, а не отвечает по существу за пятерых
   * сразу. `property` и `digest` взаимоисключающие: пост либо про один объект,
   * либо про подборку.
   */
  digest?: { propertyShortIds: number[] };
}

// Тот же select для обоих способов найти объект — карточка нужна промту
// одинаковая, различается только то, ЧЕМ публикацию узнают.
const propertySelect = {
  id: true,
  shortId: true,
  rooms: true,
  type: true,
  areaSqm: true,
  price: true,
  currency: true,
  status: true,
  marketType: true,
  district: { select: { name: true } },
  publishedOnSite: true,
  siteListingId: true,
  // Хозяин объекта — чтобы интерес из комментария вёл заявку к нему (recordClientInterest).
  intakeAgentId: true,
  assignedAgentId: true,
  createdById: true,
} as const;

/** Публикации меняются редко, а комментарии под одной идут пачками — без кэша
 *  каждый комментарий стоил бы отдельного запроса в Graph API. */
const mediaCache = new Map<string, { value: MediaContext; at: number }>();
const MEDIA_CACHE_MS = 30 * 60 * 1000;
const MEDIA_CACHE_MAX = 200;

/**
 * @param tokenOverride маркер аккаунта, под чьей публикацией комментарий
 *   (resolveIncomingAccount в handleComment). БЕЗ НЕГО — живая прод-ошибка
 *   22.08.2026: «Публикация Instagram 18102088739523645 не получена: Graph API
 *   HTTP 400: Object with ID … does not exist». Ровно тот же баг, что 17.08.2026
 *   был у эндпоинта сообщений («The requested user cannot be found», см.
 *   MessengerAccount.messagingId): при нескольких подключённых аккаунтах чужой
 *   маркер не видит чужую публикацию. Побочный эффект дороже самой ошибки —
 *   context.property не находится, и бот отвечает под постом общими словами
 *   вместо цены и района из карточки.
 *
 *   Кэш по-прежнему по одному mediaId: публикация принадлежит ОДНОМУ аккаунту, и
 *   загруженное значение верно независимо от того, чьим маркером её достали.
 *   Неудача не кэшируется вовсе (см. ниже), так что промах чужим маркером не
 *   отравляет полчаса ленты.
 */
/** Номера объектов подборки для промта — отсортированы, чтобы «№12, №4, №7»
 *  не звучало как случайный порядок SocialDigestPost.propertyIds. */
async function digestPropertyShortIds(propertyIds: string[]): Promise<{ propertyShortIds: number[] }> {
  const rows = await prisma.property.findMany({
    where: { id: { in: propertyIds }, deletedAt: null },
    select: { shortId: true },
  });
  return { propertyShortIds: rows.map((r) => r.shortId).sort((a, b) => a - b) };
}

async function loadMediaContext(
  mediaId: string,
  channel: MessengerChannel,
  tokenOverride?: string
): Promise<MediaContext> {
  if (!mediaId) return {};
  // Ключ кэша с каналом: идентификатор публикации Facebook (`{page-id}_{post-id}`)
  // и идентификатор публикации Instagram живут в разных пространствах имён, и
  // общий ключ однажды свёл бы их вместе.
  const cacheKey = `${channel}:${mediaId}`;
  const cached = mediaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MEDIA_CACHE_MS) {
    if (!cached.value.property) return cached.value;
    // Кэш нужен ради запроса в Graph API (permalink, подпись), а не ради карточки:
    // цена и статус объекта меняются, и бот обязан назвать их ПУБЛИЧНО свежими, а не
    // получасовой давности (CHANNEL-NEW-35). Один запрос по id; объект ушёл в Корзину —
    // карточку из контекста убираем, как будто публикация объекту не принадлежит.
    const property = await prisma.property.findFirst({
      where: { id: cached.value.property.id, deletedAt: null },
      select: propertySelect,
    });
    const { property: _stale, ...rest } = cached.value;
    return property ? { ...rest, property } : rest;
  }

  const media = await fetchMedia(mediaId, channel, tokenOverride);
  const context: MediaContext = { permalink: media?.permalink, caption: media?.caption };

  if (channel === "YOUTUBE") {
    // YouTube не даёт короткого кода в адресе видео — объект ищем по прямой
    // привязке videoId → Property.publishedPostIds.YOUTUBE (см.
    // lib/publishedListingSync.ts), а не по разбору ссылки.
    const property = await prisma.property.findFirst({
      where: { publishedPostIds: { path: ["YOUTUBE"], equals: mediaId }, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: propertySelect,
    });
    if (property) context.property = property;
  } else if (channel === "FACEBOOK") {
    /**
     * FACEBOOK ИСКАЛ ОБЪЕКТ КОРОТКИМ КОДОМ INSTAGRAM — ТО ЕСТЬ НЕ ИСКАЛ ВОВСЕ
     * (найдено 18.09.2026 по жалобе владельца «комментарий под видео на Facebook
     * без ответа»).
     *
     * Ветка ниже разбирает `permalink` регуляркой instagramShortcode, а она
     * совпадает ТОЛЬКО с instagram.com/(reel|reels|p|tv)/… . У страницы Facebook
     * адрес другой (`permalink_url`, facebook.com/…/videos/…), код не находился
     * никогда, и каждый комментарий на странице уходил в промт с
     * UNKNOWN_PROPERTY_RULES: «цену, площадь и адрес НЕ называй, позови в директ».
     * Под роликом, опубликованным из CRM, бот отвечал общей фразой вместо цены и
     * района — а на вопрос «Нарх?» такой ответ модель законно закрывает как
     * `ignore`, то есть молчанием.
     *
     * Ищем прямой привязкой, как у YouTube: publishAlbum пишет id видео страницы
     * в Property.publishedPostIds.FACEBOOK (см. lib/videoHandoff.ts и
     * lib/socialPublish.ts::publishFacebookVideo). Сверяем ТРИ вида одного и того
     * же идентификатора, потому что webhook и Graph называют его по-разному:
     *  - сам mediaId (`post_id` из вебхука, обычно `{page-id}_{post-id}`);
     *  - его вторую половину: POST /{page-id}/videos отдаёт БЕЗ префикса страницы;
     *  - число из адреса публикации (`/videos/123`, `/posts/123`) — им же id
     *    оказывается у роликов, где `post_id` и id видео не совпадают.
     * Все три — сравнение на равенство по одному JSON-пути, то есть один запрос.
     */
    const candidates = new Set<string>([mediaId]);
    const suffix = mediaId.includes("_") ? mediaId.slice(mediaId.lastIndexOf("_") + 1) : null;
    if (suffix) candidates.add(suffix);
    const fromPermalink = media?.permalink?.match(/\/(?:videos|posts|reel|photos)\/(?:[^/]*\/)?(\d{5,})/);
    if (fromPermalink) candidates.add(fromPermalink[1]);

    const property = await prisma.property.findFirst({
      where: {
        deletedAt: null,
        OR: [...candidates].map((id) => ({ publishedPostIds: { path: ["FACEBOOK"], equals: id } })),
      },
      // Тот же порядок и та же причина, что у Instagram ниже: один и тот же ролик
      // мог быть привязан к двум карточкам, и публично звучала бы цена случайной.
      orderBy: { createdAt: "desc" },
      select: propertySelect,
    });
    if (property) context.property = property;
    // Фото-пост Facebook (28.09.2026, agent-brief.md) — тот же приём, что у
    // Instagram ниже: mediaId/secondaryId фото-поста, а не publishedPostIds
    // видео-конвейера. Своей подписи в карточку не пишет, ничего не чинит.
    if (!context.property) {
      const byPhotoPost = await prisma.propertyPhotoPost.findFirst({
        where: {
          channel: "FACEBOOK",
          status: "PUBLISHED",
          OR: [...candidates].flatMap((id) => [{ mediaId: id }, { secondaryId: id }]),
        },
        orderBy: { createdAt: "desc" },
        select: { propertyId: true },
      });
      if (byPhotoPost) {
        const found = await prisma.property.findFirst({
          where: { id: byPhotoPost.propertyId, deletedAt: null },
          select: propertySelect,
        });
        if (found) context.property = found;
      }
    }
    // Подборка Facebook (28.09.2026, agent-brief.md reposts-digests) — тем же
    // приёмом, что фото-пост чуть выше: mediaId публикации ищем среди трёх
    // строк-каналов SocialDigestPost (одна публикация — три строки, по одной
    // на канал, см. её докстринг в prisma/schema.prisma).
    if (!context.property) {
      const digestPost = await prisma.socialDigestPost.findFirst({
        where: {
          channel: "FACEBOOK",
          status: "PUBLISHED",
          OR: [...candidates].flatMap((id) => [{ mediaId: id }, { secondaryId: id }]),
        },
        orderBy: { createdAt: "desc" },
        select: { propertyIds: true },
      });
      if (digestPost) context.digest = await digestPropertyShortIds(digestPost.propertyIds);
    }
  } else {
    // Объект ищем ровно тем же способом, что и для пересланного поста в личке
    // (см. sharedMedia.ts): по короткому коду публикации, а не по строке адреса —
    // у одной публикации адреса отличаются доменом и хвостом ?igsh=…
    const code = instagramShortcode(media?.permalink);
    if (code) {
      const property = await prisma.property.findFirst({
        where: { instagramUrl: { contains: code }, deletedAt: null },
        // Порядок задан явно: одну и ту же ссылку на рилс агенты вставляют в две
        // карточки (обычная ошибка ввода), и без orderBy база вольна вернуть любую.
        // Промт обязывает назвать цену и район ПУБЛИЧНО — то есть под постом звучала
        // бы цена другой квартиры, каждый раз своя. Свежая карточка вернее старой.
        orderBy: { createdAt: "desc" },
        select: propertySelect,
      });
      if (property) context.property = property;
    }
    /**
     * ПОЛЕ «ССЫЛКА НА INSTAGRAM» ПУСТОЕ — ИЩЕМ ЕЩЁ ДВУМЯ ПУТЯМИ (25.09.2026).
     *
     * Живой случай владельца: под обычным роликом объекта набралось четыре
     * комментария, и сервер прислал тревогу «похоже на новую рекламу, привяжите к
     * кампании». Ролик был наш, но искался только по полю ссылки — а его у карточки
     * могло не быть. Тот же объект не находился и для ответа бота: вместо цены и
     * района — «напишите в директ».
     *  - прямая привязка: id публикации, который сохраняет автопубликация в
     *    Property.publishedPostIds.INSTAGRAM (как у YouTube и Facebook выше);
     *  - номер «Объект №N» в подписи: публикация прочитана НАШИМ маркером, то есть
     *    подпись наша, а не текст клиента — тот же довод и то же самоисцеление
     *    ссылки, что у пересланного поста в личке (sharedMedia.ts).
     */
    if (!context.property) {
      const byId = await prisma.property.findFirst({
        where: { publishedPostIds: { path: ["INSTAGRAM"], equals: mediaId }, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: propertySelect,
      });
      if (byId) context.property = byId;
    }
    /**
     * ФОТО-ПОСТ (28.09.2026, agent-brief.md) — объект без ролика, опубликованный
     * каруселью/одиночным фото. ПЕРЕД поиском по «№N» в подписи (ниже): фото-пост
     * своей подписи не пишет обратно в карточку, поиск по номеру в подписи ищет
     * ЕГО ЖЕ текст (photoPostCaption собирает подпись тем же withPostFooter/
     * shortId, что и ролик) — то есть нашёл бы этот же объект вторым, более
     * дорогим путём. БЕЗ healInstagramUrl: фото-пост — не Reels, чинить
     * Property.instagramUrl по нему нельзя (см. докстринг lib/photoPosts.ts —
     * это же самое поле снимает блокер продажи «нет ссылки на Reels»).
     */
    if (!context.property) {
      const byPhotoPostId = await prisma.propertyPhotoPost.findFirst({
        where: { channel: "INSTAGRAM", mediaId, status: "PUBLISHED" },
        orderBy: { createdAt: "desc" },
        select: { propertyId: true },
      });
      const photoPostCode = !byPhotoPostId && media?.permalink ? instagramShortcode(media.permalink) : null;
      const byPhotoPostPermalink = photoPostCode
        ? await prisma.propertyPhotoPost.findFirst({
            where: { channel: "INSTAGRAM", permalink: { contains: photoPostCode }, status: "PUBLISHED" },
            orderBy: { createdAt: "desc" },
            select: { propertyId: true },
          })
        : null;
      const propertyId = byPhotoPostId?.propertyId ?? byPhotoPostPermalink?.propertyId;
      if (propertyId) {
        const property = await prisma.property.findFirst({ where: { id: propertyId, deletedAt: null }, select: propertySelect });
        if (property) context.property = property;
      }
    }
    /**
     * ПОДБОРКА (28.09.2026, agent-brief.md reposts-digests) — тот же
     * двухшаговый приём, что у фото-поста чуть выше (сначала прямой mediaId,
     * затем короткий код по permalink). ПЕРЕД поиском по «№N» в подписи ниже:
     * подпись подборки не содержит формат withPostFooter одного объекта
     * (список из нескольких «№…» строк), поиск по единственному shortId там
     * всё равно не нашёл бы её корректно.
     */
    if (!context.property) {
      const byDigestId = await prisma.socialDigestPost.findFirst({
        where: { channel: "INSTAGRAM", mediaId, status: "PUBLISHED" },
        orderBy: { createdAt: "desc" },
        select: { propertyIds: true },
      });
      const digestCode = !byDigestId && media?.permalink ? instagramShortcode(media.permalink) : null;
      const byDigestPermalink = digestCode
        ? await prisma.socialDigestPost.findFirst({
            where: { channel: "INSTAGRAM", permalink: { contains: digestCode }, status: "PUBLISHED" },
            orderBy: { createdAt: "desc" },
            select: { propertyIds: true },
          })
        : null;
      const propertyIds = byDigestId?.propertyIds ?? byDigestPermalink?.propertyIds;
      if (propertyIds) context.digest = await digestPropertyShortIds(propertyIds);
    }
    if (!context.property && !context.digest && media?.permalink) {
      const shortId = captionShortId(media.caption);
      if (shortId != null) {
        const byCaption = await prisma.property.findFirst({
          where: { shortId, deletedAt: null },
          select: { ...propertySelect, instagramUrl: true },
        });
        if (byCaption) {
          const { instagramUrl, ...property } = byCaption;
          context.property = property;
          // Ссылку чиним, только если поле пустое или не Instagram: второй ролик
          // того же объекта не должен затирать уже верную ссылку на первый.
          if (!instagramShortcode(instagramUrl)) await healInstagramUrl(property.id, instagramUrl, media.permalink);
        }
      }
    }
  }

  // НЕУДАЧУ НЕ КЭШИРУЕМ (16.08.2026). `fetchMedia` возвращает null при любом отказе
  // Graph API, и раньше пустой контекст всё равно ложился в кэш на полчаса. Один
  // таймаут в минуту запуска рекламы — и ВСЯ волна комментариев следующие 30 минут
  // отвечала «напишите в директ» вместо цены, хотя объект в базе есть. Отказ обязан
  // стоить один комментарий, а не полчаса ленты.
  if (!media) return context;

  if (mediaCache.size >= MEDIA_CACHE_MAX) {
    const oldest = mediaCache.keys().next().value;
    if (oldest) mediaCache.delete(oldest);
  }
  mediaCache.set(cacheKey, { value: context, at: Date.now() });
  return context;
}

/**
 * Составной идентификатор публикации Facebook: `{page-id}_{post-id}`.
 *
 * Щиток, а не лечение прод-случая: разбор 22.08.2026 показал, что падавший в проде
 * идентификатор (18102088739523645, error_subcode 33) был обычным инстаграмным, и
 * виноват был ЧУЖОЙ маркер. Но составной идентификатор в канале Instagram означает
 * перепутанный канал, а ошибка Graph на него («Object with ID … does not exist»)
 * читается как пропавшая публикация и уводит разбор в другую сторону. Дешевле
 * назвать это своим именем сразу.
 */
function isFacebookCompositeId(mediaId: string): boolean {
  return /^\d+_\d+$/.test(mediaId);
}

/**
 * Адрес и подпись публикации. Отказ не должен лишать комментатора ответа —
 * без карточки объекта бот ответит общими словами, и это лучше молчания.
 *
 * КАНАЛ РЕШАЕТ И ДОМ, И НАЗВАНИЯ ПОЛЕЙ (22.08.2026). Раньше сюда всегда шёл
 * эндпоинт Instagram — и для комментариев СТРАНИЦЫ Facebook тоже, хотя у неё и дом
 * другой (graph.facebook.com, маркер страницы), и поля называются иначе:
 * `permalink_url` вместо `permalink`, `message` вместо `caption`. Комментарии
 * Facebook в этой таблице живут с 16.08.2026 (см. поле channel), и получить по ним
 * публикацию было нельзя в принципе.
 *
 * @param tokenOverride маркер аккаунта, под чьей публикацией комментарий; маркер из
 *   Настроек остаётся запасным вариантом для установок с одним аккаунтом.
 */
async function fetchMedia(
  mediaId: string,
  channel: MessengerChannel,
  tokenOverride?: string
): Promise<{ permalink?: string; caption?: string } | null> {
  // YouTube ходит своим Bearer-токеном через Data API v3, а не через Graph —
  // весь запрос и разбор ошибок живут в youtubeComments.ts.
  if (channel === "YOUTUBE") return fetchYouTubeVideoInfo(mediaId);

  const credentials = await loadCredentials();
  const facebook = channel === "FACEBOOK";
  const token = tokenOverride || (facebook ? credentials.pageToken : credentials.igToken);
  if (!token) return null;

  /**
   * Составной идентификатор в канале Instagram — это перепутанный канал, а не
   * пропавшая публикация. Ходить с ним в Graph бессмысленно: ответ известен
   * заранее (HTTP 400), а в журнале он читается как «пост удалили».
   */
  if (!facebook && isFacebookCompositeId(mediaId)) {
    void logSystemError(
      "meta",
      `Публикация ${mediaId} выглядит как публикация СТРАНИЦЫ Facebook ({page-id}_{post-id}), ` +
        `а комментарий помечен каналом Instagram. В Graph за ней не идём: адрес и маркер разные. ` +
        `Если комментарий действительно из Facebook — проверьте поле channel у записи (messengers/comments.ts).`
    );
    return null;
  }

  const path = facebook
    ? `/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}?fields=permalink_url,message`
    : `/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}?fields=permalink,caption`;
  try {
    const req = instagramRequest(
      facebook ? `https://graph.facebook.com${path}` : instagramApiUrl(path),
      token
    );
    const res = await fetchWithRetry(req.url, { headers: req.headers });
    if (!res.ok) throw new Error(`Graph API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const media = (await res.json()) as {
      permalink?: string;
      caption?: string;
      permalink_url?: string;
      message?: string;
    };
    return facebook
      ? { permalink: media.permalink_url, caption: media.message }
      : { permalink: media.permalink, caption: media.caption };
  } catch (err) {
    void logSystemError(
      "meta",
      `Публикация ${facebook ? "Facebook" : "Instagram"} ${mediaId} не получена: ${describeError(err)}. ` +
        `Кампании воронки, привязанные к ней ссылкой (а не идентификатором), сегодня не сработают: ` +
        `сверять нечего — адрес публикации не получен (lib/leadMagnet.ts, pickCampaign).`
    );
    return null;
  }
}

// ─── Решение модели ─────────────────────────────────────────────────────────

export type { CommentAction, CommentDecision } from "@royal-home/shared";

export interface CommentPromptInput {
  text: string;
  authorName?: string | null;
  isThreadReply: boolean;
  /** Сколько раз мы уже отвечали ЭТОМУ автору под ЭТОЙ публикацией за сутки.
   *  Нужно промту, а не только ограничителю: со второго ответа здороваться
   *  нельзя. Владелец увидел в проде два «Ассалом алейкум» подряд одному
   *  человеку под одним постом — так пишет только робот. */
  answered: number;
  /** YouTube не имеет личных сообщений вовсе (в отличие от Instagram/Facebook,
   *  где под постом есть директ) — buildCommentSystem меняет для него совет
   *  «напишите в директ» на контакты агентства (см. YOUTUBE_NO_DM_LINE). */
  channel: MessengerChannel;
  /** Наши последние публичные ответы в этом канале — чтобы не повторять их дословно:
   *  одинаковые ответы под постами Instagram считает накруткой, а люди — автоматом. */
  recentReplies?: string[];
}

/** Строка промта с последними ответами; пусто, когда их нет. */
export function recentRepliesLine(replies: string[] | undefined): string {
  const list = (replies ?? []).map((r) => r.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
  if (list.length === 0) return "";
  return (
    "Наши последние ответы под постами — НЕ повторяй их формулировки и начало, скажи по-другому:\n" +
    list.map((r) => `- «${r.slice(0, 160)}»`).join("\n") +
    "\n"
  );
}

/**
 * Системный промт для ответа на комментарий. Вынесен и экспортирован нарочно:
 * правила «отвечай по существу из карточки», «не здоровайся дважды», «не зови в
 * директ из директа» и «претензия — не спам» должны проверяться тестом, а не на
 * живых подписчиках.
 *
 * `custom` — текст из Настроек. Пусто (не задан, пробелы) означает «взять
 * зашитый по умолчанию»: очищенное поле обязано вернуть стандартное поведение,
 * а не оставить бота без инструкций.
 */
export function buildCommentSystem(
  input: CommentPromptInput,
  context: MediaContext,
  custom?: string | null
): string {
  const propertyLine = context.property ? knownPropertyRules(context.property) : context.digest ? digestRules(context.digest) : UNKNOWN_PROPERTY_RULES;
  const captionLine = context.caption
    ? `Подпись под публикацией: «${context.caption.slice(0, 600)}»`
    : "Подписи под публикацией нет.";

  // Приветствие — одноразовое. Второй «Ассалом алейкум» тому же человеку под тем
  // же постом виден всей ленте и выдаёт бота вернее любого другого признака.
  const greetingLine =
    input.answered > 0
      ? "ЭТОМУ ЧЕЛОВЕКУ МЫ УЖЕ ОТВЕЧАЛИ под этой публикацией. Здороваться повторно ЗАПРЕЩЕНО: никаких " +
        "«Ассалом алейкум», «Салом», «Здравствуйте», «Привет» — ни в публичном ответе, ни в личном. " +
        "Начинай сразу с сути, как продолжают начатый разговор.\n"
      : "Этому человеку под этой публикацией мы ещё не отвечали — можно один раз коротко поздороваться.\n";

  return (
    (custom?.trim() || DEFAULT_COMMENT_PROMPT) +
    COMMENT_TONE_RULES +
    recentRepliesLine(input.recentReplies) +
    "\n" +
    greetingLine +
    "\n" +
    `${captionLine}\n${propertyLine}\n` +
    (input.isThreadReply ? "Это ответ в уже идущей ветке комментариев.\n" : "") +
    (input.channel === "YOUTUBE" ? YOUTUBE_NO_DM_LINE : "") +
    // Свой текст из Настроек заменяет промт по умолчанию целиком — правила скрытия и
    // удаления дописываются к нему кодом (см. COMMENT_MODERATION_RULES).
    (custom?.trim() ? `Правила модерации (действуют всегда):\n${COMMENT_MODERATION_RULES}` : "") +
    // Формат ответа задаётся кодом, а не настройкой: убери его владелец случайно
    // из своего текста — модель начала бы отвечать простым текстом, и ни один
    // комментарий не получил бы ответа.
    "Ответ ВСЕГДА передавай через инструмент submit_reply, никогда обычным текстом."
  );
}

/**
 * YouTube — ЕДИНСТВЕННЫЙ из трёх каналов без личных сообщений вовсе (Instagram и
 * Facebook отвечают в директ/Messenger тем же комментарием, см. maybeSendPrivateReply).
 * Промт по умолчанию (DEFAULT_COMMENT_PROMPT/DM_RULES) на каждом шагу зовёт «в
 * директ» — для YouTube это инструкция в никуда, и модель обязана заменить её на
 * WhatsApp/Telegram агентства. Номер и сайт берёт из фактов агентства — они с
 * 17.09.2026 уже в systemStable для ЛЮБОГО канала (см. decideOnComment), поэтому
 * здесь AGENCY_COMPANY_INFO больше не дублируется.
 */
const YOUTUBE_NO_DM_LINE =
  "ЭТО YOUTUBE: личных сообщений (директа) здесь не существует вовсе. «Напишите в директ», «ба direct нависед» " +
  "и подобное — ЗАПРЕЩЕНО, писать тут больше некуда. Если нужно продолжить разговор — зови в WhatsApp или Telegram " +
  "агентства по контактам из фактов агентства выше.\n";

/** Промт комментариев из Настроек. null — владелец его не менял, действует
 *  зашитый по умолчанию. Отказ базы не должен лишать комментатора ответа. */
async function loadCommentPrompt(): Promise<string | null> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botCommentPrompt: true },
    });
    return settings?.botCommentPrompt ?? null;
  } catch (err) {
    void logSystemError("meta", `Промт комментариев не прочитан, берём стандартный: ${describeError(err)}`);
    return null;
  }
}

/**
 * Язык. Прошлая версия просила «отвечать на языке комментария» и получала
 * книжный перевод: «Барои маълумоти дақиқ ба хабарҳои шахсӣ мурочиат кунед».
 * Так в Душанбе не говорит никто, а «хабарҳои шахсӣ» — вообще выдуманный перевод
 * слова «директ», которое таджикоязычные пишут как есть.
 */
export const LANGUAGE_RULES =
  "ЯЗЫК: отвечай СТРОГО на языке комментария. Таджикский — таджикской кириллицей, русский — по-русски, " +
  "английский — по-английски, узбекский — по-узбекски. Переходить на другой язык запрещено.\n" +
  "Пиши так, как говорит живой риелтор в Душанбе: простые обиходные слова, короткие фразы. Книжные и " +
  "канцелярские обороты ЗАПРЕЩЕНЫ — читатель должен слышать человека, а не перевод из учебника.\n" +
  "Слова «директ» и «DM» пиши как есть, НЕ переводи. Обороты «хабарҳои шахсӣ», «паёмҳои шахсӣ», " +
  "«мактуби шахсӣ», «маълумоти дақиқ», «мурочиат намоед» использовать ЗАПРЕЩЕНО. По-таджикски правильно: " +
  "«ба мо нависед», «ба директ нависед», «дар директ мефиристем».\n" +
  // Владелец 17.09.2026: под YouTube ушло «ёрии калон мерасонем» — буквальный перевод русского
  // «окажем большую помощь», так в Душанбе не говорят. Модель сочиняет вежливую концовку сама,
  // поэтому концовка задаётся списком, а не вкусом модели.
  "КОНЦОВКА: не выдумывай вежливых концовок. Обороты «ёрӣ мерасонем», «ёрии калон мерасонем», " +
  "«кӯмак мерасонем», «дар хизмати Шумо», «бо эҳтиром» ЗАПРЕЩЕНЫ — это перевод с русского. " +
  "Заканчивай ответ по делу: либо без концовки, либо ровно «Агар савол бошад, нависед.»\n" +
  // Тот же список, что и в переписке (ai/leadQualifier.ts, <language_and_slang>) — владелец
  // разметил живые ответы 17.09.2026 сразу по обоим каналам, слова книжные в обоих местах.
  "ЗАПРЕЩЁННЫЕ СЛОВА: «баррасӣ мекунем» (вообще не употреблять, даже как «рассмотрим»), «бидонед», " +
  "«равон кунем» (пиши «мефиристем»), «мушаххас кунед» (пиши «аниқ гуед»), «бо камоли майл», «бо ҷону дил» — " +
  "цветистая книжная вежливость, так под постом не пишут.\n";

/**
 * Сценарии под постом, размеченные владельцем по живым ответам 17.09.2026: бот
 * предлагал варианты аренды (которой нет), «рассматривал» чужие города вместо
 * отказа и путал, кто перед ним — покупатель или продавец, предлагающий свою
 * квартиру. Код, а не пожелание: тексты отказа фиксированы, чтобы не гулять от
 * комментария к комментарию.
 */
export const COMMENT_SCENARIO_RULES =
  "\n<сценарии_под_постом>\n" +
  "АРЕНДА (иҷора/аренда/снять/сдать): аренды у нас нет. Одна вежливая фраза об этом (факт — в АГЕНТСТВЕ выше) " +
  "и всё. Номер телефона НЕ проси, в директ по этому поводу НЕ зови.\n" +
  "ДРУГОЙ ГОРОД (не Душанбе): работаем ТОЛЬКО по Душанбе (см. факты агентства). Откажи одной вежливой фразой " +
  "СРАЗУ. ЗАПРЕЩЕНО «баррасӣ мекунем», «можем рассмотреть» и любые похожие обещания. ЗАПРЕЩЕНО ЛЮБОЕ ОБЕЩАНИЕ " +
  "ЗВОНКА ИЛИ СВЯЗИ (владелец 17.09.2026): «агент позвонит», «агенти мо тамос мегирад», «свяжемся в ближайшее " +
  "время» и всё в этом духе — этого не будет, номер сам не проси. Если человек уже сам оставил номер или " +
  "написал про свою квартиру — ответь ровно так: «Записали, спасибо. Пока работаем только по Душанбе; если " +
  "начнём работать в вашем городе — напишем.» / «Сабт кардем, раҳмат. Ҳоло танҳо дар Душанбе кор мекунем; агар " +
  "дар шаҳри шумо сар кунем, менависем.»\n" +
  "ПРОДАВЕЦ-СОБСТВЕННИК (продаёт СВОЮ квартиру, дом, участок: спрашивает нас про условия или просто выложил " +
  "объявление) — action=owner, см. правила выбора action. Подробности условий и выгод мы напишем ему в личку сами, " +
  "под постом их не расписывай.\n" +
  "ДВУСМЫСЛЕННЫЙ ЗАПРОС «квартира нужна» без слова «купить»/«снять»: не предлагай объект сразу — одним вопросом " +
  "уточни «Харид ё иҷора?» / «Купить или снять?».\n" +
  "</сценарии_под_постом>\n";

/** Правила публичного ответа, когда объект в карточке НАЙДЕН.
 *
 *  Отдельной функцией, потому что это главная правка после прода: бот видел в
 *  промте цену и район, но всё равно отправлял человека в личку общей фразой.
 *  Владелец: «он ничего конкретно не сказал, хотя вся информация есть в карточке
 *  рилса». Значит, «отвечай по существу» должно стоять требованием, а не намёком. */
function knownPropertyRules(property: NonNullable<MediaContext["property"]>): string {
  const link = siteListingUrl(property);
  return (
    `Объект из карточки CRM: ${describeProperty(property as Parameters<typeof describeProperty>[0])}.\n` +
    (link
      ? `Ссылка на объект: ${link} — давай её ровно так, символ в символ, и только в личном сообщении.\n`
      : "Объект на сайте не опубликован — ссылки на него нет, выдумывать адрес запрещено.\n") +
    "ОБЪЕКТ ИЗВЕСТЕН, значит публичный ответ ОБЯЗАН отвечать по существу: назови цену и район прямо под постом, " +
    "а если спросили про площадь или комнаты — назови и их. Отвечать общей фразой и отправлять человека в " +
    "директ вместо ответа ЗАПРЕЩЕНО: спросили «Дар кучо? Чанд сомон?» — сразу пиши район и цену.\n" +
    "В директ зови ТОЛЬКО за тем, чего в карточке нет: фото, торг, документы, похожие варианты. " +
    "И только вдобавок к уже названным цене и району, а не вместо них.\n" +
    // Решение владельца 02.08.2026: публичный ответ отвечает на вопрос и на этом
    // заканчивается. Зазывать под постом («приходите посмотреть», «омада бинед») —
    // навязчиво: это читают посторонние, и выглядит оно как реклама, а не ответ.
    "ЗВАТЬ СМОТРЕТЬ КВАРТИРУ В ПУБЛИЧНОМ ОТВЕТЕ ЗАПРЕЩЕНО ВООБЩЕ: ни «приходите посмотреть», ни «омада бинед», " +
    "ни «приезжайте». Ответил на вопрос — закончил.\n" +
    "Но если человек прямо под постом говорит, что готов купить, называет свою цену или просит скидку — это " +
    "торг, и тут зови в личные сообщения смело: там продолжится разговор о цене.\n" +
    "Цену, площадь, район и комнаты бери ТОЛЬКО отсюда. Если объект уже не в продаже — скажи об этом честно " +
    "и предложи посмотреть похожее. Если спрашивают именно ЗА СКОЛЬКО объект продали (цену сделки) — скажи, что " +
    "квартира продана, а цену сделки НЕ называй ни в каком виде (владелец 17.09.2026); предложи похожие варианты."
  );
}

/** Публикация без объекта: назвать нечего, и вот здесь личка уместна. */
const UNKNOWN_PROPERTY_RULES =
  "Публикация не привязана к объекту в базе: цену, площадь и адрес НЕ называй вообще. Коротко и по-человечески " +
  "позови написать нам в директ, чтобы там ответить по существу.";

/**
 * ПОДБОРКА (28.09.2026, agent-brief.md reposts-digests) — публикация про
 * НЕСКОЛЬКО объектов разом (см. MediaContext.digest). Решение по умолчанию:
 * бот называет номера, чтобы комментатору было что записать/спросить, но НЕ
 * придумывает цену/район/площадь по номеру — их у бота в этом контексте нет
 * (полные карточки подборки промту не передаются, см. докстринг digest в
 * MediaContext), а угадать по памяти было бы враньём под чужим постом.
 */
function digestRules(digest: NonNullable<MediaContext["digest"]>): string {
  const numbers = digest.propertyShortIds.map((n) => `№${n}`).join(", ");
  return (
    `Это ПОДБОРКА нескольких объектов, не один: ${numbers}. Цену, площадь и точный адрес конкретного объекта ` +
    "из этого списка ты НЕ знаешь — не выдумывай их. Назови комментатору интересующий его номер из списка (если " +
    "он уже написал, какой) и позови в директ, чтобы там ответить по нему конкретно."
  );
}

/**
 * Личное сообщение. В проде бот написал В ДИРЕКТ «свяжитесь с нами в директе» —
 * то есть позвал человека туда, где тот уже находится. Отсюда прямой запрет и
 * требование сразу давать пользу: комментатора надо превращать в лид, а не
 * пересылать по кругу.
 */
const DM_RULES =
  "dm — личное сообщение автору. Пиши его ТОЛЬКО когда человек проявил интерес к объекту (спросил цену, район, " +
  "«свободна ли»). Если повода нет — оставь пустым.\n" +
  "ЭТО СООБЩЕНИЕ УЖЕ ПРИХОДИТ ЧЕЛОВЕКУ В ДИРЕКТ. Звать его в директ, в личные сообщения, «напишите нам в DM», " +
  "«ҳамин ҷо дар DM тамос гиред» — бессмыслица и ЗАПРЕЩЕНО.\n" +
  "Личное сообщение обязано сразу давать пользу, в таком порядке: 1) конкретика из карточки — цена, район, " +
  "площадь, комнаты; 2) ссылка на объект, если она есть выше. Если объекта в карточке нет — ничего не " +
  "выдумывай, спроси, что человек ищет.\n" +
  // Владелец 20.09.2026, глядя на живое письмо: «бот карточку отправил, получилось
  // красиво — а почему ещё раз ссылку отправил?» Instagram сам рисует из ссылки
  // карточку с фото и заголовком, и она нажимается; подпись «Ишора ба объект:» и
  // длинный адрес посреди письма выглядят вторым, сломанным экземпляром того же.
  "ССЫЛКУ СТАВЬ ПОСЛЕДНЕЙ СТРОКОЙ, ОТДЕЛЬНО И БЕЗ ПОДПИСИ. Ни «Ишора ба объект:», ни «Ссылка:», ни " +
  "«Подробнее:» — просто адрес сам по себе, в самом конце письма. Мессенджер сам покажет из него карточку " +
  "объекта с фотографией, и подпись рядом с ней выглядит как вторая, сломанная ссылка.\n" +
  // Решение владельца 02.08.2026: звать смотреть квартиру человеку, который написал
  // «цена?» под постом, — это забегание вперёд. Он спросил цену, а не показ.
  // Приглашение уместно, когда интерес уже подтверждён словами, и не в каждом письме.
  "ЗВАТЬ НА ПОКАЗ В ПЕРВОМ ЖЕ ПИСЬМЕ НЕЛЬЗЯ. «Кай бароятон қулай аст, омада бинед?», «приезжайте посмотреть», " +
  "«когда вам удобно приехать» — только если человек САМ заговорил о просмотре, встрече или сказал, что " +
  "квартира подходит. Спросил цену — назови цену и остановись.\n" +
  // Решение владельца 02.08.2026. Разговор о цене и скидке — это уже не любопытство,
  // а торг: человек примеряет покупку на себя. Здесь осторожность вредна.
  "ИСКЛЮЧЕНИЕ, И ОНО ВАЖНОЕ: человек говорит, что ГОТОВ КУПИТЬ, называет свою цену, просит скидку или " +
  "спрашивает «уступите?», «охирин нарх чанд?» — зови смело и сразу: и к нам в офис, и продолжить разговор " +
  "здесь. Торг у нас есть всегда, но РАЗМЕР скидки не называй — это решает агент с собственником. " +
  "Скажи, что вопрос решаемый, и предложи следующий шаг.\n" +
  "Вопрос в конце ставь ТОЛЬКО когда он действительно нужен, и не больше одного. Молчаливый ответ по существу " +
  "лучше вежливого вопроса ни о чём: человек, которому интересно, напишет сам.\n";

/**
 * Как узнавать спам и чужую рекламу — ЗАДАЁТСЯ КОДОМ ВСЕГДА (24.09.2026).
 *
 * Своё поле в Настройках («Промт ответов на комментарии») ЗАМЕНЯЕТ промт по
 * умолчанию целиком. Значит любой свой текст — или копия стандартного, сохранённая
 * однажды кнопкой «Сохранить», — навсегда отрезал бота от новых правил модерации:
 * правка правила в коде до прода просто не доходила. Именно так уже было с личностью
 * бота (routes/settings.ts, «прод две недели работал по тексту от 1 августа»).
 * Поэтому эти два пункта стоят и в промте по умолчанию, и дописываются кодом после
 * своего текста (buildCommentSystem) — так же, как формат ответа.
 */
export const COMMENT_MODERATION_RULES =
  "- hide — откровенный спам: ссылки на посторонние сайты, «пиши на вотсап», криптовалюта, ставки, накрутка " +
  "подписчиков, заработок в интернете.\n" +
  "- delete — удаляется сразу и безвозвратно (владелец 24.09.2026): мат, плохие слова, оскорбления, хейт, травля, " +
  "угрозы; а также реклама ДРУГОГО агентства недвижимости или риелтора (услуги, «подберём квартиру», «большой " +
  "выбор», «подписывайтесь на нашу страницу»). ВАЖНО: недовольство, претензия и критика по делу — НЕ хейт; на " +
  "них отвечают вежливо, а не удаляют.\n" +
  "- owner — СОБСТВЕННИК продаёт СВОЮ недвижимость: выложил под постом объявление о своей квартире, доме или " +
  "участке («хона дорем, нарх 580, занг занед», «продаю свою квартиру, 3 комнаты»), или пишет, что хочет продать " +
  "своё («хонамро фурӯхтан мехоҳам», «хочу продать через вас, какие условия?»). Это НЕ спам и НЕ конкурент, а " +
  "наш будущий продавец: мы сами напишем ему в личку, расскажем, что делаем для продавца, и спросим подробности. " +
  "Если он спросил НАС — в reply одна короткая фраза, что написали ему в директ («Ба директ навиштем» / «Написали " +
  "вам в директ»). Если он просто выложил объявление для читателей — reply оставь пустым: объявление мы скроем.\n" +
  "Отличай агентство от собственника по словам: «агентство», «риелтор», «услуги», «подберём», «большой выбор», " +
  "много объектов сразу — агентство (delete); «своя квартира», «собственник», «без посредников», «хона дорем», " +
  "один конкретный объект — собственник (owner). Сомневаешься — owner: собственника удалять нельзя.\n";

/**
 * Постоянная часть промта — та, что владелец правит в Настройках («Бот» →
 * «Промт ответов на комментарии»). Здесь только правила поведения, без фактов
 * конкретного комментария: карточка объекта, подпись поста, приветствие и формат
 * ответа подставляются кодом в buildCommentSystem и правке не подлежат — иначе
 * очищенное поле лишало бы бота данных, а не инструкций.
 *
 * Объявлен ПОСЛЕ блоков правил нарочно: const в модуле вычисляется сверху вниз,
 * и ссылка на LANGUAGE_RULES выше по файлу упала бы при импорте («Cannot access
 * before initialization»), а не в тесте.
 */
/**
 * ЖИВОЙ ТОН ПОД ПОСТОМ (Dan 02.10.2026: «иногда сухо отвечает без смайлов, просто
 * с восклицательным знаком — прокачай»). Собрано по руководствам SMM (Sprout Social,
 * NapoleonCat, Spur, SMMplanner, Wahelp, Texterra, Code95, vc.ru), разбор —
 * /mnt/project-files/bot-audit-02-10/comment-replies-research.md.
 *
 * Причин сухости было две, и обе в коде, а не в модели: промт называл смайлик
 * уместным ТОЛЬКО в ответ на «🔥», а фильтр (cleanOutgoingReply без allowOneEmoji)
 * вырезал любой смайлик из текстового ответа. Оставался голый текст с «!».
 *
 * Дописывается кодом и к своему промту из Настроек: тон — не формат, но без него
 * свой текст снова дал бы сухие ответы. Личной переписки не касается — там
 * смайликов нет по решению владельца 22.08.2026.
 */
export const COMMENT_TONE_RULES =
  "\n<тон_под_постом>\n" +
  "Пиши как тёплый живой SMM-менеджер, а не как справочная. Устройство ответа: суть (цена, район, ответ на вопрос) " +
  "и, если уместно, один мягкий следующий шаг. Каждый ответ несёт хотя бы одну конкретику: район, этаж, цену, " +
  "«есть похожие рядом».\n" +
  "СМАЙЛИК: в обычном дружелюбном ответе ставь ОДИН подходящий смайлик — в конце фразы или рядом с призывом " +
  "(📩 рядом с «директ», 📍 рядом с районом). Подходят: 😊 🙌 ✨ 🤍 🏡 🏠 🔑 📩 📞 📍; 🔥 и 😍 — только в ответ на восторг. " +
  "Не ставь 🙂 (читается как ехидство), 🙏 (двусмысленно) и 😂. БЕЗ смайлика вовсе: жалоба, претензия, недовольство " +
  "ценой, спор, отказ (аренда, другой город), объект продан, документы и ипотека, escalate.\n" +
  "ВОСКЛИЦАТЕЛЬНЫЙ ЗНАК — не больше одного на ответ. Живость дают слова и смайлик, а не «!».\n" +
  "Зеркаль собеседника: пишет коротко и сухо — ответь коротко и спокойно; пишет с восторгом и смайликами — ответь " +
  "так же живо. Обращение на «Вы» / «Шумо». «Ака», «апа», «ҷон» не используй: пол и возраст не угадать.\n" +
  "Не начинай каждый ответ одинаково («Здравствуйте!», «Спасибо за интерес!», «Салом!»): меняй начало, порядок и слова. " +
  "Благодарность чередуй: «Ташаккур» / «Раҳмат», «Спасибо» / «Благодарим».\n" +
  "Примеры тона (не копируй дословно): «Эта двушка в Сино — 68 000 $ 🏡 Про рассрочку расскажем в директе 📩» / " +
  "«Нархи ин хона 540 000 сомонӣ, дар ноҳияи Сино 📍» / «Рады, что понравилось 🤍 Вживую вид ещё лучше» / " +
  "«Ташаккур, хурсандем, ки маъқул шуд ✨».\n" +
  "</тон_под_постом>\n";

export const DEFAULT_COMMENT_PROMPT =
  // «в Instagram» было единственным упоминанием канала и врало с 16.08.2026, когда
  // в ту же очередь легли комментарии страницы Facebook, и с 17.09.2026 — YouTube.
  // Канал подставляет код (см. buildCommentSystem, YOUTUBE_NO_DM_LINE), а промт
  // не должен утверждать обратное: модель, которой сказано «ты в Instagram»,
  // зовёт в «директ» и там, где его нет.
  "Ты — консультант агентства недвижимости Royal Home в Душанбе и отвечаешь на комментарии под нашими " +
  "публикациями в соцсетях. Сам себя ИИ не называй; на прямой вопрос «ты бот?» честно подтверди одной фразой и продолжай по делу.\n" +
  "Публичный ответ читают посторонние: он короткий (одна-две фразы), доброжелательный, без тире «—», " +
  "без хештегов и без гирлянды эмодзи. Ничего не выдумывай: цена, площадь, район и наличие — только из данных ниже.\n\n" +
  LANGUAGE_RULES +
  "\nКак выбрать action:\n" +
  "- reply — обычный вопрос или отклик по делу.\n" +
  COMMENT_MODERATION_RULES +
  "- escalate — ты не знаешь ответа: спрашивают о документах, рассрочке, торге, ходе конкретной сделки, жалуются " +
  "на сотрудника или требуют того, чего в данных ниже нет. Тогда в reply напиши одну короткую вежливую фразу " +
  "(«сейчас уточним и вернёмся с ответом»), а в reason — чего именно не хватило.\n" +
  "- ignore — отвечать не на что: отметка друга, случайный набор букв.\n\n" +
  // Решение владельца 02.08.2026. Общий запрет смайликов касается ЛИЧНОЙ переписки:
  // там бот изображает делового человека. Под постом всё наоборот — молчание в ответ
  // на «🔥» выглядит высокомерно, а живой человек ставит сердечко и идёт дальше.
  // Одно, а не гирлянда: стена эмодзи под своим же постом читается как накрутка.
  "ЕСЛИ КОММЕНТАРИЙ — ЭТО ТОЛЬКО СМАЙЛИК ИЛИ КОРОТКАЯ ПОХВАЛА («🔥», «класс», «зӯр»), ответь ОДНИМ смайликом " +
  "(можно с одним словом благодарности) и выбери action=reply. Гирлянду из нескольких смайликов не ставь никогда; " +
  "в ЛИЧНОМ сообщении (поле dm) смайликов нет вовсе. Как ставить смайлик в обычном ответе — см. тон под постом.\n\n" +
  DM_RULES;

/** Последние наши публичные ответы в канале; сбой базы — просто без них. */
async function recentPublicReplies(channel: MessengerChannel): Promise<string[]> {
  const rows = await prisma.instagramComment
    .findMany({
      where: { channel, status: "REPLIED", replyText: { not: null } },
      orderBy: { repliedAt: "desc" },
      take: 8,
      select: { replyText: true },
    })
    .catch(() => []);
  return rows.map((r) => r.replyText ?? "").filter(Boolean);
}

/**
 * Публичный ответ: один смайлик можно, один «!» максимум (тон под постом). Лишние
 * «!» становятся точкой; ответ из одних смайликов не трогаем вовсе.
 */
export function cleanPublicCommentReply(raw: string, clientText = ""): string {
  if (isReactionOnly(raw)) return stripMachineTypography(raw);
  const cleaned = cleanOutgoingReply(raw, clientText, { allowOneEmoji: true });
  let seen = false;
  return cleaned.replace(/!+/g, () => {
    if (seen) return ".";
    seen = true;
    return "!";
  });
}

async function decideOnComment(input: CommentPromptInput, context: MediaContext): Promise<CommentDecision | null> {
  const author = input.authorName ? `@${input.authorName}` : "подписчик";
  const capabilities = commentDecisionCapabilities(input.channel);
  const decision = await callAiText<unknown>({
    endpoint: "instagram-comment",
    // Условия агентства и правила работы с возражениями — те же, что в переписке.
    // Без них комментарии отвечали вслепую: на «арзон намекнен?» («подешевле не
    // будет?») бот выдал «кажется дорого, но цену мы поставили по рынку» — то есть
    // защитил цену и отказал, хотя торг у нас есть ВСЕГДА и правило прямо запрещает
    // оправдываться. Он этого просто не знал: промт комментариев собирается отдельно.
    // Блок стабильный, поэтому уходит в кэшируемую часть и платится один раз.
    //
    // MANDATORY_BOT_RULES и адреса из своей базы добавлены 16.08.2026. До этого дня
    // ветка комментариев не получала НИ карты районов Душанбе, НИ списка жилых
    // комплексов, НИ запрета обращений по полу — всё это склеивалось только в личной
    // переписке (ai/leadQualifier.ts). Выходило наоборот тому, чего требует цена
    // ошибки: под постом, где текст видят все подписчики, бот знал о городе меньше,
    // чем в личке с одним человеком, и спрашивал «Бустон Сити тарафи кадом район?».
    systemStable: AGENCY_COMPANY_INFO + SALES_FACTS + (await folkGeographyBlock()) + MANDATORY_BOT_RULES + COMMENT_SCENARIO_RULES + (await propertyGeographyBlock()),
    // Выводы из случаев, где бот уже ошибался (lib/botLessons.ts) — та же функция,
    // что и в личной переписке (ai/leadQualifier.ts). В ИЗМЕНЯЕМУЮ часть промта, а
    // прямо в чате, см. routes/conversations.ts POST /:id/reply-feedback) чаще, чем
    // живёт кэш, и внутри кэшируемого блока новое правило не пробилось бы в промт,
    // пока не сменится что-то ещё в стабильной части (см. тот же приём и комментарий
    // в leadQualifier.ts).
    system: buildCommentSystem(input, context, await loadCommentPrompt()) + (await learnedRulesBlock("comments")),
    user: `Комментарий от ${author}: «${input.text}»`,
    maxTokens: 400,
    // Комментарий читают посторонние — это лицо компании на публике, и экономить
    // здесь нельзя (прямое указание владельца 31.07.2026). Один неудачный ответ под
    // постом видят все подписчики, в отличие от неудачной реплики в личке.
    effort: "high",
    schema: commentDecisionProviderSchema(capabilities),
  });
  return validateCommentDecision(decision, capabilities, "instagram-comment");
}

// ─── Действия в Instagram ───────────────────────────────────────────────────

/** Публичный ответ под комментарием. Возвращает идентификатор нашей реплики —
 *  по нему мы потом узнаём собственные комментарии.
 *  @param tokenOverride маркер аккаунта, под чьим постом комментарий (accounts.ts) —
 *  без него Meta отклонит ответ, если пост принадлежит НЕ аккаунту по умолчанию. */




async function hideComment(channel: MessengerChannel, commentId: string, tokenOverride?: string): Promise<void> {
  await setCommentHidden(channel, commentId, true, tokenOverride);
}

/** Удалить комментарий безвозвратно. Только для рекламы чужой недвижимости под
 *  нашим постом (см. правило `delete` в DEFAULT_COMMENT_PROMPT) — весь остальной
 *  спам по-прежнему только скрывается, чтобы руководство могло его увидеть.
 *  @param tokenOverride маркер аккаунта, под чьим постом комментарий (accounts.ts) —
 *  для YOUTUBE не нужен, там свой Bearer-токен (youtubeComments.ts). */
async function deleteComment(channel: MessengerChannel, commentId: string, tokenOverride?: string): Promise<void> {
  if (channel === "YOUTUBE") return deleteYouTubeComment(commentId);
  if (channel !== "INSTAGRAM" && channel !== "FACEBOOK") throw new Error("Unsupported comment moderation channel");
  const { url, token } = await commentApi(channel, `/${encodeURIComponent(commentId)}`, tokenOverride);
  const response = await callGraph(url, token, undefined, "DELETE");
  requireModerationAccepted(graphModerationOutcome(channel, "delete", response));
}

// Личное сообщение автору комментария (private reply) живёт в messengers/meta.ts:
// тем же путём ходит воронка лид-магнита, и вторая копия транспорта разъехалась бы
// с первой же правкой.

// ─── Разбор очереди ─────────────────────────────────────────────────────────

export interface CommentRunStats {
  replied: number;
  hidden: number;
  deleted: number;
  escalated: number;
  skipped: number;
}

export type QueuedComment = {
  id: string;
  /** INSTAGRAM | FACEBOOK: определяет адрес Graph и маркер (см. commentApi). */
  channel: string;
  commentId: string;
  mediaId: string;
  /** В какой наш аккаунт пришёл комментарий — им же уходит приглашение воронки. */
  accountExternalId: string | null;
  parentId: string | null;
  authorId: string;
  authorName: string | null;
  text: string;
  status: string;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Разбирает подошедшие комментарии. Зовётся кроном раз в минуту.
 *
 * Берём и застрявшие в WORKING: процесс мог упасть между «взял в работу» и
 * ответом, и такая запись иначе не отвечает никогда, молча.
 */
export async function processDueComments(now: Date = new Date()): Promise<CommentRunStats> {
  await expireUnsentPublicAgentPlans();
  const stats: CommentRunStats = { replied: 0, hidden: 0, deleted: 0, escalated: 0, skipped: 0 };
  /**
   * Общий ползунок «отвечать на комментарии» — один на оба канала, и без него
   * очередь разбирать незачем. А вот КАНАЛЬНЫЙ рубильник у Instagram и Facebook
   * свой, и проверять его надо у каждой записи по её собственному channel
   * (22.08.2026): прежний общий вызов спрашивал только про Instagram, и выключенный
   * Instagram останавливал разбор комментариев страницы Facebook заодно.
   */
  if (!(await loadBotCapabilities()).comments) return stats;

  const due = (await prisma.instagramComment.findMany({
    where: {
      OR: [
        { status: "PENDING", replyDueAt: { lte: now } },
        // Потолок попыток здесь — БОЛЬШИЙ из двух (ИИ-недоступность терпит 12):
        // застрявший в WORKING комментарий с пятой попыткой ИИ-сбоя всё ещё наш.
        { status: "WORKING", updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) }, attempts: { lt: AI_DOWN_MAX_ATTEMPTS } },
      ],
    },
    orderBy: { replyDueAt: "asc" },
    take: BATCH_LIMIT,
  })) as QueuedComment[];

  /**
   * ПАРАЛЛЕЛЬНО, А НЕ ПО ОЧЕРЕДИ (05.09.2026, вместе с переносом человеческой паузы
   * на публикацию — см. humanReplyDelay). Обычный ответ теперь сам ждёт 1-2 минуты
   * ПЕРЕД отправкой, и при последовательном разборе спам-комментарий, попавший в
   * выборку следом за ним, ждал бы эту чужую паузу впустую — то есть удалялся бы
   * не быстрее прежнего, хотя сам по себе больше не должен ждать вовсе.
   * mapWithConcurrency (см. lib/concurrency.ts) держит предел одновременных внешних
   * вызовов (COMMENT_CONCURRENCY) — не Promise.all без границы.
   */
  //
  // ОДИН АВТОР — ПО ОЧЕРЕДИ (02.10.2026). Два комментария одного человека в одной
  // выборке («Нарх?» и «Дар куҷо?» с разницей в секунды) шли параллельно: оба
  // хода читали «отвечали ли мы ему» и лимит личных до того, как первый записал
  // ответ, и человек получал два приветствия и два сообщения в директ. Разные
  // авторы по-прежнему идут параллельно.
  const byAuthor = new Map<string, QueuedComment[]>();
  for (const row of due) {
    const key = `${row.channel}:${row.authorId}`;
    const group = byAuthor.get(key);
    if (group) group.push(row);
    else byAuthor.set(key, [row]);
  }
  await mapWithConcurrency([...byAuthor.values()], COMMENT_CONCURRENCY, async (group) => {
    for (const row of group) await processClaimedComment(row, stats);
  });
  return stats;
}

async function processClaimedComment(row: QueuedComment, stats: CommentRunStats): Promise<void> {
  {
    // Захват записи. Тик крона может обогнать предыдущий (проход делает вызовы
    // ИИ и Graph API на каждый комментарий), и без захвата два прохода ответили
    // бы на один комментарий дважды — на глазах у подписчиков.
    const claimed = await prisma.instagramComment.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: "WORKING", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;

    try {
      // Рубильник КАНАЛА этой записи. Проверяем после захвата и закрываем запись
      // насовсем — тем же «bot_off», что ставит приём (ingestInstagramComments):
      // иначе выключенный канал оставлял бы свои комментарии вечно висеть в
      // очереди, и они вытесняли бы из выборки живые.
      if (!(await isCommentsBotEnabled(row.channel as MessengerChannel))) {
        await finish(row.id, { status: "SKIPPED", note: "bot_off" });
        stats.skipped++;
        return;
      }
      const outcome = await handleComment(row);
      stats[outcome]++;
    } catch (err) {
      await failComment(row, err);
    }
  }
}

/**
 * Обработка одного комментария: решение модели и всё, что из него следует.
 * Экспортирована ради тестов — правила модерации, лимит личных и защита от
 * зацикливания обязаны проверяться без крона и без живого Instagram.
 */
export async function handleComment(row: QueuedComment): Promise<keyof CommentRunStats> {
  // A retained managed origin cannot enter legacy account/funnel/DM/moderation,
  // even after rollout OFF or when its genuine source proof has expired.
  try {
    const lane = await publicAgentCommentLane(row.id);
    if (lane === "moved") {
      // Ветка уже переведена на ядро (31.10): старый движок здесь не отвечает.
      await finish(row.id, { status: "SKIPPED", note: "legacy_lane_moved" });
      return "skipped";
    }
    if (lane === "managed") {
      const draft = await prepareCustomerPublicAgentDraft({ table: "meta", id: row.id });
      if (draft.status === "moderate") {
        const outcome = await executeCustomerPublicModeration(draft.principal);
        return outcome === "held" ? "skipped" : outcome;
      }
      if (draft.status === "readyDraft") {
        await postManagedPublicCommentReply(draft.principal, draft.text, { agentRevisionId: draft.agentRevisionId,
          publicReadWitness: draft.factsReadWitness, publicDataWitness: draft.publicDataWitness });
        return "replied"; // Only P12 accepted receipt + exact projection reaches here.
      }
      if (draft.status === "skip") {
        await finishPublicAgentDecision(draft.principal, { kind: "skip", reason: draft.reason });
      } else if (draft.status === "moderation_proposal") {
        const committed = await finishPublicAgentDecision(draft.principal, { kind: "review",
          reason: `moderation_${draft.action}_${draft.reason}` });
        return committed ? "escalated" : "skipped";
      } else if (draft.principal && draft.reason === "staff_review_required") {
        const committed = await finishPublicAgentDecision(draft.principal, { kind: "review", reason: "staff_review_required" });
        return committed ? "escalated" : "skipped";
      }
      // Operational skipped counter only; HELD never marks the source REPLIED,
      // releases an UNKNOWN attempt or enters generic legacy full-turn retry.
      return "skipped";
    }
  } catch {
    void logSystemError("ai", "Обработка публичного комментария общим ядром приостановлена; прежний сценарий не запускался.");
    return "skipped";
  }
  /**
   * Чей это пост: ответ/скрытие/личное по комментарию обязаны уйти маркером
   * ИМЕННО того аккаунта, под чьей публикацией комментарий, — Meta отклоняет
   * такие действия чужим токеном, если аккаунтов подключено несколько (accounts.ts).
   *
   * КАНАЛ БЕРЁМ ИЗ ЗАПИСИ, а не «INSTAGRAM» жёстко (22.08.2026). Таблица названа
   * исторически, но с 16.08.2026 в неё ложатся и комментарии страницы Facebook
   * (поле channel, см. prisma/schema.prisma). Жёсткий «INSTAGRAM» подбирал
   * инстаграмный аккаунт и его маркер даже для строк FACEBOOK — то есть ответ,
   * скрытие и личное по комментарию со страницы уходили заведомо чужим маркером и
   * в чужой дом Graph.
   *
   * YOUTUBE ИСКЛЮЧЕНИЕ: там нет понятия «аккаунт Meta» и нет маркера-строки —
   * youtubeComments.ts сам получает Bearer-токен по client_id/secret/refresh_token
   * из Настроек при каждом вызове. resolveIncomingAccount звать не за чем: она
   * ищет строку в таблице аккаунтов Meta, которой для YouTube никогда не будет.
   */
  const channel = row.channel as MessengerChannel;
  const account =
    channel === "YOUTUBE"
      ? { id: null as string | null, title: "YouTube", token: undefined as string | undefined }
      : await resolveIncomingAccount(row.channel, row.accountExternalId ?? undefined);
  // Выбор «по умолчанию» не подтверждает namespace: scoped facade отклоняет
  // guessed запись досье/истории, сохраняя прежнюю привязку и карантин legacy.
  // Флаг не даёт permission на запись или перенос переписки в другой аккаунт.
  const accountGuess = "certain" in account && account.certain === false;

  // Защита от зацикливания: одному человеку под одной публикацией отвечаем
  // ограниченное число раз в сутки. Дальше — молчим, разговор продолжает человек.
  /**
   * РУЧНЫЕ ОТВЕТЫ СОТРУДНИКА В СЧЁТ НЕ ИДУТ (18.09.2026).
   *
   * Ответ из CRM ложится той же строкой, что и ответ бота (status="REPLIED", см.
   * routes/instagramComments.ts POST /:id/reply), и отличается только пометкой
   * `manual_reply`. То есть агент, разобравший под постом четыре вопроса руками,
   * выбирал боту его суточную норму по этому человеку — и следующий комментарий
   * оставался без ответа ИМЕННО ПОТОМУ, что люди работали. Ограничитель заведён
   * против зацикливания бота, а зацикливаться может только бот.
   *
   * КАНАЛ ТОЖЕ В УСЛОВИИ: mediaId у Instagram, страницы Facebook и YouTube лежат
   * в разных пространствах имён (у YouTube это videoId), и совпадение строк между
   * каналами хоть и маловероятно, но запирало бы чужой разговор наглухо.
   */
  const answered = await prisma.instagramComment.count({
    where: {
      channel: row.channel,
      authorId: row.authorId,
      mediaId: row.mediaId,
      status: "REPLIED",
      // Явным OR, а не `note: { not: … }`: у ответа бота note чаще всего NULL
      // (или пометка личного — "dm_limit"), а SQL-условие `note <> 'manual_reply'`
      // строки с NULL не возвращает — ограничитель не сработал бы вовсе.
      OR: [{ note: null }, { note: { not: "manual_reply" } }],
      repliedAt: { gte: new Date(Date.now() - DAY_MS) },
    },
  });
  if (answered >= MAX_REPLIES_PER_AUTHOR_PER_MEDIA) {
    await finish(row.id, { status: "SKIPPED", note: "loop_guard" });
    return "skipped";
  }

  /**
   * ВОРОНКА ЛИД-МАГНИТА — ПЕРЕД ВСЕМ ОСТАЛЬНЫМ И БЕЗ ЕДИНОГО ОБРАЩЕНИЯ К ИИ.
   *
   * Под рекламным роликом человек пишет ключевое слово, и ему уходит файл в
   * директ. Проверяем это до ответа смайликом и до модели по двум причинам: под
   * рекламой комментарий вида «🔥» тоже может быть заявкой на чек-лист (если
   * кампания ловит любой комментарий), а платить за ход модели ради сравнения
   * строк незачем — реклама приводит сотни человек за вечер.
   *
   * Адрес публикации берём из уже загруженного контекста: он кэширован на
   * полчаса, и лишнего запроса в Graph API здесь не будет (см. loadMediaContext).
   */
  // Воронка живёт ТОЛЬКО в Instagram: приглашение уходит private reply через
  // graph.instagram.com, а выдача — в Instagram Direct (см. lib/leadMagnet.ts).
  // Для комментария со страницы Facebook она не сработала бы, зато перехватила бы
  // ход у обычного бота и оставила человека без ответа вовсе.
  if (channel === "INSTAGRAM" && (await leadMagnetActive())) {
    // Маркер аккаунта поста обязателен: чужим Graph отвечает «Object with ID … does
    // not exist», и объект из карточки не находится (см. loadMediaContext).
    const context = await loadMediaContext(row.mediaId, channel, account.token);
    const funnel = await tryLeadMagnetComment(
      {
        commentId: row.commentId,
        mediaId: row.mediaId,
        parentId: row.parentId,
        authorId: row.authorId,
        authorName: row.authorName,
        text: row.text,
        createdAt: row.createdAt,
        accountExternalId: row.accountExternalId ?? undefined,
      },
      context.permalink
    );
    if (funnel) {
      const replyCommentId = funnel.publicReply
        ? await postCommentReply(row, funnel.publicReply, account.token)
        : null;
      const answered = Boolean(funnel.publicReply || funnel.dmSent);
      await finish(row.id, {
        status: answered ? "REPLIED" : "SKIPPED",
        note: funnel.note,
        propertyId: context.property?.id,
        ...(funnel.publicReply ? { replyText: funnel.publicReply, replyCommentId, repliedAt: new Date() } : {}),
        ...(funnel.dmSent ? { dmSentAt: new Date(), dmText: funnel.dmText } : {}),
      });
      return answered ? "replied" : "skipped";
    }
  }

  /**
   * СЛОВО ВОРОНКИ — ТОЛЬКО ВОРОНКЕ (решение владельца 16.08.2026).
   *
   * Сюда мы попадаем, когда воронка не сработала: кампанию забыли включить, ролик
   * другой, окно ответа истекло. Если человек при этом написал ключевое слово,
   * отвечать обычным ботом ЗАПРЕЩЕНО: он напишет «напишите в директ», человек
   * решит, что это и был ответ, и обещанный файл никто не попросит.
   *
   * Живой случай: кампания выключена, под роликом «Дастур», и бот ответил
   * «Салом! Ба директ нависед, бо камоли майл маълумот медиҳем». Реклама оплачена,
   * отклик потерян, и по переписке этого не видно — виден вежливый ответ.
   */
  // Адрес публикации уже загружен и закэширован на полчаса — лишнего запроса
  // в Graph здесь не будет (см. loadMediaContext); переиспользуем и в тревоге ниже.
  const mediaContext = channel === "INSTAGRAM" ? await loadMediaContext(row.mediaId, channel, account.token) : undefined;
  const mediaPermalink = mediaContext?.permalink;
  const funnel =
    channel === "INSTAGRAM"
      ? await isFunnelKeyword({ text: row.text, mediaId: row.mediaId, permalink: mediaPermalink })
      : null;
  if (funnel) {
    const what = funnel.reason === "keyword" ? "ключевое слово воронки" : "публикация воронки";
    void logSystemError(
      "meta",
      funnel.enabled
        ? `Комментарий «${row.text.slice(0, 40)}» — ${what} «${funnel.campaignName}», но выдать файл не вышло (истёк срок ответа или человек уже получал). Бот на него не отвечал.`
        : `Комментарий «${row.text.slice(0, 40)}» — ${what} «${funnel.campaignName}», а кампания ВЫКЛЮЧЕНА. Человек пришёл с рекламы и остался без файла: включите кампанию в Настройках → Воронка.`
    );
    await finish(row.id, { status: "SKIPPED", note: `${what} — отвечает только воронка` });
    return "skipped";
  }

  /**
   * НОВАЯ РЕКЛАМА ПОД НЕПРИВЯЗАННЫМ ПОСТОМ — ТРЕВОГА ПО ВСПЛЕСКУ, А НЕ ПОСТФАКТУМ
   * (разбор 30.08.2026: 78 человек за 5 дней написали ключевое слово под рекламным
   * роликом, которого не было ни в одной кампании — isFunnelKeyword здесь просто
   * молчала, и об этом узнали только из ручного разбора переписок).
   *
   * `funnel === null` выше покрывает случай «слово или пост УЗНАНЫ, но кампания
   * не сработала» — а здесь другой: пост воронке вообще неизвестен, поэтому
   * сказать «это она» нечем. Единственный доступный сигнал — сам всплеск
   * комментариев под одной публикацией, когда в CRM хоть одна кампания включена.
   *
   * Считаем ПОСЛЕ уже вставленной строки (createMany выше по функции), поэтому
   * этот самый комментарий уже входит в счёт. Ровно на пороге, а не «>=»: иначе
   * тревога повторялась бы на каждом следующем комментарии до конца дня и её
   * перестали бы читать. Текст без числа и без цитаты комментария — стабильный,
   * чтобы 10-минутный дедуп logSystemError (26.08.2026, «по первым 160 символам»)
   * схлопнул повторы, а не показал каждый как новую запись.
   */
  // Ролик нашего объекта — не реклама, привязывать его некуда (Dan 25.09.2026:
  // «зачем мне к кампании привязывать, это обычный объект»).
  if (channel === "INSTAGRAM" && !mediaContext?.property && (await leadMagnetActive())) {
    const recentUnderSamePost = await prisma.instagramComment.count({
      where: { mediaId: row.mediaId, createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    });
    if (recentUnderSamePost === UNBOUND_AD_ALERT_THRESHOLD) {
      void logSystemError(
        "meta",
        `Под публикацией ${mediaPermalink ?? row.mediaId} за два часа набралось ${recentUnderSamePost} ` +
          `комментариев, а лид-магнит её не узнаёт вовсе — ни по ссылке, ни по идентификатору. ` +
          `Похоже на новую рекламу, которую забыли привязать к кампании (Настройки → Воронка → публикации).`
      );
    }
  }

  /**
   * АВТОР УЖЕ В ВОРОНКЕ — ДАЖЕ БЕЗ КЛЮЧЕВОГО СЛОВА В ЭТОМ КОММЕНТАРИИ.
   *
   * Проверка выше (`isFunnelKeyword`) смотрит только текст ЭТОГО комментария.
   * Человек, которому уже ушло приглашение, следующим комментарием обычно
   * пишет что-то своими словами («готово», «ок», простое спасибо) — мимо
   * ключевых слов. Без этой проверки такой комментарий уходил обычному
   * ИИ-боту, а тот отвечал за воронку сам, без файла и с придуманным текстом
   * — второе, лишнее «спасибо за подписку» рядом с настоящей выдачей (см.
   * lib/leadMagnet.ts: hasPendingLeadMagnetDelivery).
   */
  if (channel === "INSTAGRAM" && (await hasPendingLeadMagnetDelivery(row.authorId))) {
    /**
     * НЕ МОЛЧАТЬ В ОТВЕТ (решение владельца 30.08.2026).
     *
     * Раньше такой комментарий просто пропускался. Разбор прода: 25 пропусков за две
     * недели — и это ровно те люди, у кого не получилось нажать кнопку в директе.
     * Человек видит, что другим бот отвечает, а ему нет, и пишет ещё раз. Со стороны
     * это выглядит так, будто его игнорируют, — при том что он пришёл с оплаченной
     * рекламы и файл ему обещан.
     *
     * Отвечаем ОДИН раз на автора: второй такой же ответ под каждым его комментарием
     * — уже навязчивость, за которую Instagram наказывает жалобами. Признак «уже
     * отвечали» берём из самой ленты комментариев, отдельного поля для этого не нужно.
     */
    const alreadyNudged = await prisma.instagramComment.findFirst({
      where: { authorId: row.authorId, note: "lm_author_nudged", id: { not: row.id } },
      select: { id: true },
    });
    if (alreadyNudged) {
      await finish(row.id, { status: "SKIPPED", note: "lm_author_pending" });
      return "skipped";
    }
    // БЕЗ ЭМОДЗИ И БЕЗ «ЛУТФАН» (правка 30.08.2026, разбор находок судьи): готовый
    // текст, минующий cleanOutgoingReply, — «лутфан» прямо запрещено правилами
    // языка (AGENCY_VOICE в ai/leadQualifier.ts, замена — «бемалол»), а публичный
    // комментарий по тем же правилам не должен нести смайлик как подпись автомата.
    const nudge = "Мо аллакай ба директи Шумо навиштем. Бемалол, онҷоро тафтиш кунед.";
    const replyCommentId = await postCommentReply(row, nudge, account.token).catch((err) => {
      void logSystemError("meta", `Воронка: напоминание про директ не ушло: ${describeError(err)}`);
      return null;
    });
    await finish(row.id, {
      status: replyCommentId ? "REPLIED" : "SKIPPED",
      note: replyCommentId ? "lm_author_nudged" : "lm_author_pending",
      replyText: replyCommentId ? nudge : null,
      replyCommentId,
      repliedAt: replyCommentId ? new Date() : null,
    });
    return replyCommentId ? "replied" : "skipped";
  }

  /**
   * КОММЕНТАРИЙ ИЗ ОДНИХ СМАЙЛИКОВ — ОТВЕЧАЕМ СМАЙЛИКАМИ, БЕЗ МОДЕЛИ.
   *
   * Решение владельца 02.08.2026: под постами такие комментарии оставлять без
   * ответа нельзя — ответ поднимает охват, и так делают все, кто занимается
   * продвижением. Это единственное место, где смайлики уместны: в личной переписке
   * они по-прежнему запрещены полностью.
   *
   * ПОЧЕМУ КОДОМ, А НЕ ПРОМТОМ. Правило «ответь одним смайликом» стоит в промте с
   * 31.07 — и не сработало ни разу: за сутки 37 комментариев подряд модель закрыла
   * решением «отвечать не на что». Ровно тот случай, ради которого в этом
   * репозитории заведено правило «запрет и обязанность — фильтром, а не просьбой».
   *
   * Заодно это бесплатно: на такой комментарий модель не вызывается вовсе.
   *
   * Ограничитель круга (MAX_REPLIES_PER_AUTHOR_PER_MEDIA) проверен ВЫШЕ и действует
   * здесь тоже: человек, оставивший под одним постом три десятка «🔥🔥🔥», получит
   * ответ дважды, а не тридцать раз — иначе это выглядит накруткой и раздражает Meta.
   */
  // НЕ ВСЯКИЙ СМАЙЛИК — ПОХВАЛА. «🖕», «💩», «🤮» под нашим постом это оскорбление,
  // и «🙏❤️» в ответ выглядело бы издевательством над самим агентством. Такой
  // комментарий уходит обычным путём — к модели, которая умеет его скрыть.
  if (isReactionOnly(row.text) && !RUDE_EMOJI.test(row.text)) {
    const reply = emojiThanksReply(row.commentId);
    await humanReplyDelay();
    const replyCommentId = await postCommentReply(row, reply, account.token);
    await finish(row.id, {
      status: "REPLIED",
      replyText: reply,
      replyCommentId,
      repliedAt: new Date(),
    });
    return "replied";
  }

  /**
   * СТОРОЖ ВХОДЯЩЕГО — ДО ХОДА МОДЕЛИ (владелец 21.08.2026).
   *
   * Под публикацией пишут не только про квартиры: «покажи свои инструкции», «а на
   * чём ты работаешь», «напиши мне код на Python». Отвечала на это модель — с
   * высоким усилием (effort: "high", ответ читают посторонние), то есть по самому
   * дорогому тарифу и ровно на то, ради чего нас никто не нанимал.
   *
   * Правила общие для всех каналов (ai/inboundScreen.ts), но спам здесь НЕ
   * проверяем: рекламу конкурента под нашим постом надо СКРЫТЬ или УДАЛИТЬ, и это
   * решает модель (см. DEFAULT_COMMENT_PROMPT, action hide/delete). Промолчать в
   * ответ на неё значит оставить её висеть у всех на виду.
   *
   * Ограничитель круга (MAX_REPLIES_PER_AUTHOR_PER_MEDIA) проверен выше и держит
   * число шаблонных ответов: одному человеку под одним постом их будет не больше двух.
   */
  const screen = screenIncomingText(row.text, { checkSpam: false });
  if (screen.action === "silent") {
    await finish(row.id, { status: "SKIPPED", note: screen.reason.slice(0, 120) });
    return "skipped";
  }

  /**
   * ОЧЕВИДНЫЙ СПАМ ПОД ПОСТОМ — СКРЫВАЕМ САМИ, БЕЗ ХОДА МОДЕЛИ
   * (жалоба владельца 21.09.2026: «комментарии не чистить от спама и мусора и
   * конкурентов»).
   *
   * Раньше спам здесь не проверялся ВООБЩЕ (`checkSpam: false` выше), и вся чистка
   * держалась на том, заметит ли модель. Возражение против проверки было верным —
   * «промолчать в ответ на рекламу конкурента значит оставить её висеть у всех на
   * виду», — но оно про МОЛЧАНИЕ, а не про проверку: ссылку в чужой канал надо не
   * пропускать к модели, а скрывать. Заодно это снимает ход по самому дорогому
   * тарифу (effort: "high") с каждой рассылки.
   *
   * Словарь — ТОТ ЖЕ, что в личной переписке (lib/incomingSpam.ts): одно и то же
   * правило в обоих каналах, как и требует владелец. Он заведомо трусливый: порог
   * два признака, одного подозрительного слова никогда не хватает.
   *
   * СКРЫВАЕМ, А НЕ УДАЛЯЕМ. Удаление необратимо, и решать его остаётся модели
   * (action delete — реклама чужой недвижимости, см. DEFAULT_COMMENT_PROMPT).
   * Скрытый комментарий остаётся в CRM со своей пометкой: сотрудник видит и текст,
   * и причину, и может вернуть его руками, если это оказался живой человек.
   */
  const obviousSpam = detectSpam(row.text, { comment: true });
  if (obviousSpam) {
    const result = await moderateOrNote(row, "hide", () => hideComment(row.channel, row.commentId, account.token));
    return finishModeration(row, result, `spam: ${obviousSpam.reason}`);
  }

  /**
   * МАТ, АГЕНТСТВА, СОБСТВЕННИКИ — КОДОМ, ДО ХОДА МОДЕЛИ (владелец 24.09.2026).
   *
   * Живой случай: объявление «Хона дорем… 58квадрат… Нарх 580… номер 980001010»
   * девять часов висело под роликом royal.home.tj открытым. Решала модель, а в её
   * промте стояли два правила о том же человеке с противоположным исходом. Владелец
   * разложил это на три случая, и каждый узнаётся словами-признаками:
   *
   *  - мат и оскорбления (lib/commentHate.ts) — удалить сразу;
   *  - реклама агентства или риелтора (detectAgencyAd) — удалить; номер, если он
   *    есть, ложится в «Прочее» (решение владельца 05.09.2026, см.
   *    createLeadFromCompetitorAd);
   *  - собственник продаёт свою квартиру (detectListingAd) — это НЕ спам, а
   *    будущий продавец. Его объявление убираем с глаз наших читателей (скрытие
   *    обратимо), а ему самому бот пишет в личку: кто мы, что делаем для
   *    продавца, как к нему обращаться и что продаёт. Карточку заводит уже
   *    разговор в личке, когда человек ответит («не сразу, сначала обработать»).
   */
  const hate = detectHate(row.text);
  if (hate) {
    const result = await moderateOrNote(row, "delete", () => deleteComment(row.channel, row.commentId, account.token));
    return finishModeration(row, result, hate.reason);
  }
  const agencyAd = detectAgencyAd(row.text);
  if (agencyAd) {
    // Отказ площадки удалить не мешает завести номер (02.10.2026): раньше
    // исключение из удаления обрывало ход, и лид «Прочее» не заводился вовсе.
    const result = await moderateOrNote(row, "delete", () => deleteComment(row.channel, row.commentId, account.token));
    await createLeadFromCompetitorAd(row, "OTHER").catch((err) => {
      void logSystemError("meta", `Реклама агентства ${row.commentId}: лид «Прочее» не заведён: ${describeError(err)}`);
    });
    return finishModeration(row, result, agencyAd.reason);
  }
  const listingAd = detectListingAd(row.text);
  if (listingAd) {
    // Не удалось скрыть — собственнику всё равно пишем и карточку заводим.
    const result = await moderateOrNote(row, "hide", () => hideComment(row.channel, row.commentId, account.token));
    return contactOwner(row, account, {
      note: result.outcome === "accepted" ? `${listingAd.reason}; ${moderationAcceptedNote(result, "")}`
        : `${listingAd.reason}; ${moderationFailureNote(result)}`,
      hidden: result.outcome === "accepted",
    });
  }

  /**
   * СУТОЧНЫЙ БЮДЖЕТ ХОДОВ ИИ — ТЕПЕРЬ И ПОД ПУБЛИКАЦИЯМИ (аудит 22.08.2026).
   *
   * Предел из решения владельца 21.08.2026 действовал только в переписке Meta: под
   * постами ходы модели не считал никто. А ход здесь дороже, чем в личке (effort:
   * "high" — ответ читают посторонние), и ограничителя, кроме двух ответов на пост,
   * не было вовсе: человеку достаточно писать под РАЗНЫМИ публикациями, чтобы
   * получать ответы модели без конца.
   *
   * СЧЁТ ПО АВТОРУ, А НЕ ПО ПУБЛИКАЦИИ: расходы создаёт один человек, и бюджет
   * обязан быть его, а не поста. Отдельный от личной переписки того же
   * человека (метка канала своя): под постом и в директе это разные разговоры, и
   * общий счёт запирал бы один из-за другого.
   *
   * ПРЕДЕЛ МЯГКИЙ, как и везде: до аварийного потолка (×5) бот работает как ни в
   * чём не бывало, а перешагнутая обычная норма только оставляет след в «Здоровье
   * системы» — ровно один раз за сутки. Числа станут настоящими из отчёта по
   * расходам через месяц (см. lib/aiDailyBudget.ts).
   */
  const { row: budgetRow, budget } = await loadPeerAiBudget(`${row.channel}_COMMENTS`, row.authorId, null);
  if (budget.softJustExceeded) {
    void logSystemError(
      "ai",
      `Комментатор ${row.authorName ? `@${row.authorName}` : row.authorId} перешагнул обычную суточную норму ` +
        `ходов ИИ под публикациями — бот продолжает отвечать, остановка только на аварийном потолке ` +
        `(lib/aiDailyBudget.ts)`
    );
  }
  if (budget.turnsLeft <= 0) {
    // Аварийный потолок. Вежливой фразы «подключится агент» здесь нет НАРОЧНО: под
    // постом её прочитают посторонние, а сам комментарий остаётся в CRM со своей
    // пометкой — сотрудник увидит и ответит руками, если сочтёт нужным.
    void logSystemError(
      "ai",
      `Комментатор ${row.authorName ? `@${row.authorName}` : row.authorId} упёрся в АВАРИЙНЫЙ суточный потолок ` +
        `ходов ИИ — бот больше не отвечает ему сегодня под публикациями. Похоже на автоматический перебор; ` +
        `если это живой человек, ответьте ему сами.`
    );
    await finish(row.id, { status: "SKIPPED", note: "ai_budget" });
    return "skipped";
  }

  const context = await loadMediaContext(row.mediaId, channel, account.token);
  // Расход засчитывается ПЕРЕД вызовом: платит сама попытка, а не удачный ответ
  // (то же правило, что в messengers/conversation.ts).
  await spendAiTurns(budgetRow.id, budget.dayKey, 1, "peer");
  // `answered` — не только ограничитель круга, но и факт для промта: если мы уже
  // отвечали этому человеку под этим постом, здороваться второй раз нельзя.
  const decision = await decideOnComment(
    {
      text: row.text,
      authorName: row.authorName,
      isThreadReply: Boolean(row.parentId),
      answered,
      channel,
      recentReplies: await recentPublicReplies(channel),
    },
    context
  );
  // Модель не ответила — это не «нечего сказать», а отказ поставщика ИИ. Помечаем
  // ошибку ИМЕННО как «ИИ недоступен»: у неё свой путь повторов — терпеливый, с
  // растущей паузой (см. failComment). Обычные три попытки рассчитаны на битые
  // данные, а не на ночной сбой поставщика: комментарий, похороненный через 15
  // минут недоступности модели, — это ровно те «исчезнувшие вопросы», которые
  // владелец запретил 16.08.2026.
  if (!decision) throw new AiUnavailableError("Модель не вернула решение по комментарию");

  if (decision.action === "hide") {
    const result = await moderateOrNote(row, "hide", () => hideComment(row.channel, row.commentId, account.token));
    return finishModeration(row, result, "spam", context.property?.id);
  }

  if (decision.action === "owner") {
    // Собственник, которого код не узнал (без номера, своими словами). Спросил НАС —
    // модель дала короткий публичный ответ, комментарий остаётся. Выложил объявление
    // для читателей — ответа нет, объявление убираем с глаз, как у кода выше.
    const publicReply = cleanPublicCommentReply(stripShowingInvite(decision.reply?.trim() ?? ""), row.text);
    if (publicReply) {
      await humanReplyDelay();
      const replyCommentId = await postCommentReply(row, publicReply, account.token);
      return contactOwner(row, account, {
        note: "owner",
        hidden: false,
        publicReply: { text: publicReply, id: replyCommentId },
        propertyId: context.property?.id,
      });
    }
    const result = await moderateOrNote(row, "hide", () => hideComment(row.channel, row.commentId, account.token));
    return contactOwner(row, account, {
      note: result.outcome === "accepted" ? `owner; ${moderationAcceptedNote(result, "")}`
        : `owner; ${moderationFailureNote(result)}`,
      hidden: result.outcome === "accepted",
      propertyId: context.property?.id,
    });
  }

  if (decision.action === "delete") {
    const result = await moderateOrNote(row, "delete", () => deleteComment(row.channel, row.commentId, account.token));
    await createLeadFromCompetitorAd(row).catch((err) => {
      void logSystemError(
        "meta",
        `Спам-комментарий ${row.commentId}: лид «Прочее» не заведён: ${describeError(err)}`
      );
    });
    return finishModeration(row, result, "competitor_ad", context.property?.id);
  }

  /**
   * ДОСЬЕ КОММЕНТАТОРА — НЕЗАВИСИМО ОТ ТОГО, УШЛО ЛИ ЛИЧНОЕ (находка ночной
   * проверки 24.09.2026, Б8, решение владельца — да).
   *
   * Раньше карточка заводилась ТОЛЬКО внутри recordPrivateReply, то есть только
   * когда личное сообщение получалось отправить. А это лишь часть комментаторов:
   * ответ внутри ветки (Meta принимает личное только по корневому комментарию,
   * note="dm_thread"), комментарий старше 7 суток (note="dm_window"), уже
   * отправленное сегодня этому человеку личное (note="dm_limit") и весь канал
   * YouTube (личных сообщений там нет вовсе, maybeSendPrivateReply возвращает
   * dm_unsupported) — во всех этих случаях бот отвечал под постом, а карточку
   * не заводил вовсе, и человек терялся вопреки решению владельца 21.09.2026
   * «карточка на каждого написавшего боту».
   *
   * Место — СРАЗУ ПОСЛЕ спам-фильтра: hide/delete выше уже вышли из функции
   * возвратом (детский spam проверен ещё раньше, см. `obviousSpam`), и ниже
   * идут только комментарии живых людей — порядок «сначала спам-фильтр, потом
   * карточка» тот же, что и до этой правки.
   *
   * ensureConversationId — тот же путь, что уже заводит диалог и досье при
   * удачном личном (recordPrivateReply ниже), с той же дедупликацией по паре
   * (channel, subscriberId): повторный комментарий того же автора карточку не
   * дублирует. Результат личного (ушло/не ушло и почему) как и раньше остаётся
   * только в InstagramComment.note/dmSentAt — сама карточка от него больше не
   * зависит.
   */
  try {
    await ensureConversationId(channel, row.authorId, row.authorName ?? undefined, account.id, accountGuess);
  } catch (err) {
    void logSystemError("meta", `Досье комментатора ${row.commentId} не заведено: ${describeError(err)}`);
  }

  /**
   * Комментарий под постом — сигнал интереса к объекту (владелец 09.09.2026,
   * см. lib/propertyInterest.ts). Спам и реклама конкурентов сюда не попадают:
   * ветки hide/delete выше уже вышли из функции, и в счётчик спроса идут только
   * комментарии живых людей.
   *
   * clientId раньше был жёстко null: у комментатора нет телефона (его требует
   * createLeadFromChannel), значит настоящую карточку CRM завести нельзя — но
   * анонимность самого события была ненужной потерей: директор, открыв «интерес
   * к объекту», не мог увидеть, КТО именно интересовался (найдено 13.09.2026).
   * Пишем идентичность автора в канале — тот же мост "канал раньше карточки",
   * что recipientId у PropertyExposure, — а не выдумываем номер и не создаём
   * лид без него.
   */
  if (context.property?.id) {
    void recordInterest(context.property.id, "COMMENT", null, { id: row.authorId, name: row.authorName });
    /**
     * И экспозиция «клиент сам интересовался» на пару (канал, автор) — ту же, по
     * которой потом живёт его директ (ensureConversationId выше берёт authorId
     * как subscriberId). Без неё человек, спросивший цену под постом и потом
     * оставивший номер в личке, уходил в общую очередь, а не агенту объекта
     * (находка треда «Бот не узнаёт наш пост в Instagram», 02.10.2026).
     * YouTube и Telegram-группа личных сообщений с этой парой не имеют.
     */
    if (channel === "INSTAGRAM" || channel === "FACEBOOK") {
      void recordClientInterest(
        {
          ...context.property,
          intakeAgentId: context.property.intakeAgentId ?? null,
          assignedAgentId: context.property.assignedAgentId ?? null,
          createdById: context.property.createdById ?? null,
        },
        channel,
        row.authorId,
        undefined,
        account.id
      );
    }
  }

  if (decision.action === "ignore") {
    await finish(row.id, {
      status: "SKIPPED",
      note: (decision.reason ?? "nothing_to_say").slice(0, 200),
      propertyId: context.property?.id,
    });
    return "skipped";
  }

  // Приглашение на показ вычёркивается из публичного ответа (см. stripShowingInvite),
  // а следом — ОБЩИЙ фильтр исходящего, тот же, что в личной переписке.
  //
  // Раньше публичный ответ чистился только от тире, а личное по комментарию не
  // чистилось вообще. То есть на самой публичной поверхности не работало ничего из
  // ai/replyGuards: ни запрет обращений по полу (случай «Фаҳмо, апаи Фарида» под
  // постом увидели бы все подписчики), ни вырезание HTML-тегов, ни «дар база», ни
  // обращение по нику, ни узбекские слова. Фильтр писался ровно от этих случаев —
  // и стоял в одном канале из двух.
  //
  // ИСКЛЮЧЕНИЕ ДЛЯ ЭМОДЗИ В ПУБЛИЧНОМ ОТВЕТЕ. Под постом ответ на «🔥» одним
  // смайликом — норма и прямо предписан промтом (в личке эмодзи запрещены). Поэтому
  // ответ, состоящий только из реакции, оставляем как есть; чистим лишь текст.
  const rawReply = stripShowingInvite(decision.reply?.trim() ?? "");
  const replyText = cleanPublicCommentReply(rawReply, row.text);
  if (replyText) await humanReplyDelay();
  const replyCommentId = replyText ? await postCommentReply(row, replyText, account.token) : null;

  // Личное только после публичного ответа: если публичный не ушёл, значит с
  // комментарием что-то не так, и лезть человеку в личку тем более не стоит.
  // Личное — это обычная переписка, и правила там ровно те же, что в директе.
  const dmText = linkAsLastLine(cleanOutgoingReply(decision.dm?.trim() ?? ""), context.property) || undefined;
  const dm = replyText ? await maybeSendPrivateReply(row, dmText, account.token) : { sent: false as const };
  // Личное ушло — оно ОБЯЗАНО появиться в переписке CRM (20.09.2026). Раньше текст
  // личного ложился только в журнал комментариев (InstagramComment.dmText), а в
  // «Сообщениях» его не было вовсе — и эхо Meta эту дыру не закрывает: транспорт
  // запоминает mid каждой своей отправки, и вебхук такое эхо намеренно гасит
  // (wasSentByUs в routes/webhooks.ts). Хуже всего это било по ссылке на объект:
  // промт прямо велит давать её ТОЛЬКО в личном (knownPropertyRules), то есть
  // ровно то, что бот отправил клиенту, для агента исчезало. Владелец 20.09.2026:
  // «в инстаграме у меня полная переписка есть, как бот отправляет ссылку, а тут
  // в CRM нет». Тот же шаг давно делает воронка лид-магнита (recordInConversation
  // в lib/leadMagnet.ts) — здесь его просто не было.
  if (dm.sent && dmText) await recordPrivateReply(row, dmText, dm.mid ?? null, account.id, accountGuess);

  if (decision.action === "escalate") {
    await escalate(row, decision.reason);
    await finish(row.id, {
      status: "ESCALATED",
      note: (decision.reason ?? "бот не знает ответа").slice(0, 200),
      replyText: replyText ?? null,
      replyCommentId,
      repliedAt: replyText ? new Date() : null,
      propertyId: context.property?.id,
      ...(dm.sent ? { dmSentAt: new Date(), dmText: dmText ?? null } : {}),
    });
    return "escalated";
  }

  if (!replyText) {
    // action=reply без текста — модель промахнулась мимо собственного решения.
    await finish(row.id, { status: "SKIPPED", note: "empty_reply", propertyId: context.property?.id });
    return "skipped";
  }

  await finish(row.id, {
    status: "REPLIED",
    replyText,
    replyCommentId,
    repliedAt: new Date(),
    propertyId: context.property?.id,
    note: dm.note ?? null,
    ...(dm.sent ? { dmSentAt: new Date(), dmText: dmText ?? null } : {}),
  });
  return "replied";
}

/**
 * ПЕРВОЕ ПИСЬМО СОБСТВЕННИКУ — готовым текстом, а не моделью (владелец 24.09.2026,
 * дословно по его перечню): кто мы; снимем объект сами и профессионально; выложим
 * на всех площадках; объект останется в CRM, и через месяц-два-три система сама
 * предложит его покупателю под описание; не только снимем и прорекламируем, но и
 * покажем, продадим и сопроводим документы. В конце — имя и что продаёт.
 *
 * Готовым текстом, потому что это первое слово агентства незнакомому человеку, и
 * оно обязано быть одинаково правильным каждый раз. Номер в первом письме не
 * просим — «не навязчиво»: его спрашивает уже разговор в личке (SCENARIO_SELL в
 * ai/leadQualifier.ts), когда человек ответит.
 */
const OWNER_DM = {
  TJ: {
    hello:
      "Ассалому алейкум! Ин Royal Home, агентии амволи ғайриманқул дар Душанбе. Дидем, ки Шумо хонаатонро " +
      "мефурӯшед, барои ҳамин навиштем.",
    buyers: (n: number) =>
      `Ҳоло дар базаи мо ${n === 1 ? "як харидор ҳаст, ки маҳз ҳамин хел хонаро меҷӯяд" : `${n === 2 ? "ду" : "якчанд"} харидор ҳаст, ки маҳз ҳамин хел хонаро меҷӯянд`}. ` +
      "Агар хоҳед, агенти мо ба Шумо занг зада ҳамаашро мефаҳмонад ва нишон доданро ташкил мекунад.",
    pitch:
      "Мо хонаи Шуморо худамон касбӣ видео мегирем ва дар ҳамаи саҳифаҳоямон мегузорем: Instagram, Facebook, " +
      "TikTok, канали Telegram ва сайти royalhome.tj. Хона дар базаи CRM-и мо мемонад: агар баъди як, ду ё се моҳ " +
      "харидор бо ҳамин талабот (ҷой, буҷа, метраж, ошёна) пайдо шавад, система хонаи Шуморо ба ӯ пешниҳод мекунад. " +
      "Мо на танҳо видео ва реклама мекунем: нишон медиҳем, мефурӯшем ва ҳуҷҷатҳоро то охир ҳамроҳӣ мекунем, то " +
      "савдо ҳам барои Шумо, ҳам барои харидор бехатар гузарад.",
    ask: "Номатон чӣ? Агар хоҳед бо мо кор кунед, дар бораи хона каме нависед.",
  },
  RU: {
    hello:
      "Здравствуйте! Это Royal Home, агентство недвижимости в Душанбе. Увидели, что вы продаёте недвижимость, " +
      "поэтому пишем.",
    buyers: (n: number) =>
      `Сейчас в нашей базе ${n === 1 ? "есть покупатель, который ищет" : `есть ${n === 2 ? "два покупателя" : "несколько покупателей"}, которые ищут`} именно такой объект. ` +
      "Если хотите, наш агент позвонит вам, всё объяснит и организует показ.",
    pitch:
      "Мы сами профессионально снимем ваш объект и выложим на всех наших площадках: Instagram, Facebook, TikTok, " +
      "Telegram-канал и сайт royalhome.tj. Объект останется в нашей CRM: если через месяц, два или три появится " +
      "покупатель под ваше описание (район, бюджет, площадь, этаж), система сама предложит ему ваш объект. Мы не " +
      "только снимаем и рекламируем, но и показываем, продаём и полностью сопровождаем документы, чтобы сделка " +
      "прошла безопасно и для вас, и для покупателя.",
    ask: "Как к вам обращаться? Если интересно с нами работать, расскажите немного об объекте.",
  },
};

/**
 * Письмо собственнику. Есть подходящие покупатели — о них первым делом, сразу
 * после приветствия (владелец 24.09.2026: «сначала скажи, что есть покупатель,
 * потом наши условия»). Только ЧИСЛО словами — «один», «два», «несколько»: ни
 * имени, ни района поиска, ни бюджета покупателя собственник не получает никогда.
 */
export function ownerDmText(tajik: boolean, buyers: number): string {
  const t = tajik ? OWNER_DM.TJ : OWNER_DM.RU;
  return [t.hello, ...(buyers > 0 ? [t.buyers(buyers)] : []), t.pitch, t.ask].join("\n\n");
}

/**
 * Собственник под нашим постом: письмо в личку, а карточка — потом, из разговора.
 *
 * Где личного нет (YouTube, ответ внутри ветки, прошло больше 7 суток, человек
 * закрыл личку), обработать разговором нельзя — тогда номер из объявления сразу
 * ложится карточкой «Продавец», и обрабатывает её агент звонком. Уже писали ему
 * сегодня (`dm_limit`) — разговор и так идёт, второй карточки не заводим.
 */
async function contactOwner(
  row: QueuedComment,
  account: { id: string | null; token?: string; certain?: boolean },
  opts: { note: string; hidden: boolean; publicReply?: { text: string; id: string | null }; propertyId?: string }
): Promise<keyof CommentRunStats> {
  // Подбор — не повод не написать: сбой подбора даёт письмо без строки о покупателях.
  const buyers = await matchBuyersForListing(row.text).catch((err) => {
    void logSystemError("meta", `Подбор покупателей под объявление ${row.commentId} не удался: ${describeError(err)}`);
    return null;
  });
  const dmText = ownerDmText(looksTajik(row.text), buyers?.total ?? 0);
  const dm = await maybeSendPrivateReply(row, dmText, account.token);
  if (dm.sent) {
    await recordOwnerConversation(row, dmText, dm.mid ?? null, account.id, account.certain === false);
  } else if (dm.note !== "dm_limit") {
    await createLeadFromCompetitorAd(row, "SELLER").catch((err) => {
      void logSystemError(
        "meta",
        `Собственник в комментарии ${row.commentId}: личное не ушло (${dm.note}), и карточка по номеру не заведена: ${describeError(err)}`
      );
    });
  }
  const note = (
    `${OWNER_NOTE_PREFIX}${opts.note}; ${dm.sent ? "написали в личку" : `личное: ${dm.note ?? "нет"}`}` +
    (buyers?.total ? `; покупателей: ${buyers.total}` : "")
  ).slice(0, 200);
  await finish(row.id, {
    status: opts.publicReply ? "REPLIED" : opts.hidden ? "HIDDEN" : "SKIPPED",
    note,
    ...(opts.hidden ? { hiddenAt: new Date() } : {}),
    ...(opts.publicReply
      ? { replyText: opts.publicReply.text, replyCommentId: opts.publicReply.id, repliedAt: new Date() }
      : {}),
    ...(opts.propertyId ? { propertyId: opts.propertyId } : {}),
    ...(dm.sent ? { dmSentAt: new Date(), dmText } : {}),
  });
  return opts.publicReply ? "replied" : opts.hidden ? "hidden" : "skipped";
}

/**
 * Письмо собственнику ложится в переписку CRM вместе с его комментарием: бот в
 * личке, получив ответ, должен видеть, что человек уже написал под постом (цена,
 * площадь, этаж), и не переспрашивать это заново.
 */
async function recordOwnerConversation(
  row: QueuedComment,
  dmText: string,
  mid: string | null,
  accountId?: string | null,
  accountGuess = false
): Promise<void> {
  if (row.channel !== "INSTAGRAM" && row.channel !== "FACEBOOK") return;
  try {
    const conversationId = await ensureConversationId(
      row.channel,
      row.authorId,
      row.authorName ?? undefined,
      accountId,
      accountGuess
    );
    await appendConversationMessages(conversationId, [
      { role: "user", content: `(комментарий под нашим постом) ${row.text}` },
      { role: "assistant", content: dmText, by: { kind: "bot" }, ...(mid ? { mid } : {}) },
    ]);
  } catch (err) {
    void logSystemError("meta", `Письмо собственнику по комментарию ${row.commentId} не записано в переписку: ${describeError(err)}`);
  }
}

/**
 * Личное сообщение автору — с двумя ограничителями.
 *
 * Первый от Meta: писать первым можно только 7 суток с момента комментария.
 * Второй наш: одно личное в сутки на человека, иначе активный комментатор
 * получает директ на каждый свой комментарий и жалуется на спам — а жалоба в
 * Instagram стоит дороже любого лида.
 */
async function maybeSendPrivateReply(
  row: QueuedComment,
  text: string | undefined,
  tokenOverride?: string
): Promise<{ sent: boolean; note?: string; mid?: string | null }> {
  if (!text) return { sent: false };
  // YouTube не имеет личных сообщений вовсе — buildCommentSystem/YOUTUBE_NO_DM_LINE
  // уже просит модель не звать в директ, но если она всё равно вернула dm (не
  // послушалась), уходить ему физически некуда: у YouTube Data API нет такого API.
  if (row.channel === "YOUTUBE") return { sent: false, note: "dm_unsupported" };
  // Личное можно отправить только по КОРНЕВОМУ комментарию: ответ внутри ветки
  // Meta для этого не принимает, и попытка стоила бы отказа в журнале на ровном месте.
  if (row.parentId) return { sent: false, note: "dm_thread" };
  if (Date.now() - row.createdAt.getTime() > PRIVATE_REPLY_WINDOW_MS) return { sent: false, note: "dm_window" };

  const recent = await prisma.instagramComment.findFirst({
    where: { authorId: row.authorId, dmSentAt: { gte: new Date(Date.now() - DAY_MS) } },
    select: { id: true },
  });
  if (recent) return { sent: false, note: "dm_limit" };

  try {
    // Канал решает, куда уйдёт личное: Instagram Direct или Messenger страницы.
    const mid = await sendPrivateReply(row.commentId, text, [], tokenOverride, row.channel as "INSTAGRAM" | "FACEBOOK");
    return { sent: true, mid };
  } catch (err) {
    // Личное — приятное дополнение к публичному ответу. Его отказ (человек закрыл
    // личку, окно истекло) не должен отменять уже опубликованный ответ.
    void logSystemError("meta", `Личное сообщение по комментарию ${row.commentId} не ушло: ${describeError(err)}`);
    return { sent: false, note: "dm_failed" };
  }
}

/**
 * Ссылка на объект — последней строкой и без подписи.
 *
 * Промт просит об этом же, но промт — просьба, а не гарантия (тот же довод, что у
 * ai/availabilityGuard.ts и stripDuplicatedCardLink в messengers/conversation.ts):
 * модель охотно пишет «Ишора ба объект: <адрес>» посреди письма. Мессенджер рисует
 * из ссылки карточку с фотографией и заголовком — она и нажимается; сырой адрес с
 * подписью рядом выглядит вторым, сломанным экземпляром той же ссылки (владелец
 * 20.09.2026, разбор живого письма клиентке).
 *
 * Вырезаем ссылку из текста, убираем осиротевшую подпись перед ней и приписываем
 * адрес в самый конец. Ссылки в тексте нет — текст возвращается как есть.
 */
export function linkAsLastLine(text: string, property: MediaContext["property"] | null | undefined): string {
  const link = property ? siteListingUrl(property) : null;
  if (!link || !text.includes(link)) return text;
  const withoutLink = text
    .split(link)
    .join(" ")
    // Подпись, оставшаяся без ссылки: «Ишора ба объект:», «Ссылка:», «Подробнее:».
    // Режем только короткий хвост со двоеточием — длинное предложение, случайно
    // кончающееся двоеточием, текстом и остаётся.
    .replace(/[^\n.!?]{0,40}:\s*(?=\n|$)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return withoutLink ? `${withoutLink}\n\n${link}` : link;
}

/**
 * Личное по комментарию — в переписку CRM, тем же приёмом, что у воронки.
 *
 * mid отправленного кладём в реплику: без него ЭТО ЖЕ сообщение, вернувшееся
 * эхом Meta, неотличимо от ручного ответа сотрудника — вебхук дописал бы вторую
 * копию и поставил бота на паузу (разбор 17.08.2026, messengers/outgoingMids.ts).
 *
 * Отказ записи не отменяет уже отправленное личное: оно у человека, и ронять из-за
 * этого разбор комментария нельзя. Причина — в журнал, молчать тут нечестно.
 */
async function recordPrivateReply(
  row: QueuedComment,
  text: string,
  mid: string | null,
  accountId?: string | null,
  accountGuess = false
): Promise<void> {
  // YouTube сюда не доходит (личных сообщений там нет вовсе, см. maybeSendPrivateReply),
  // но проверка стоит явно: переписки этого канала в BotConversation не бывает.
  if (row.channel !== "INSTAGRAM" && row.channel !== "FACEBOOK") return;
  try {
    const conversationId = await ensureConversationId(
      row.channel,
      row.authorId,
      row.authorName ?? undefined,
      accountId,
      accountGuess
    );
    // Сам комментарий — тоже в переписку, как в recordOwnerConversation
    // (02.10.2026): без него бот в директе не знал, о чём человек спросил под
    // постом, и на его «ҳа» снова спрашивал, что он ищет и какой номер.
    await appendConversationMessages(conversationId, [
      { role: "user", content: `(комментарий под нашим постом) ${row.text}` },
      { role: "assistant", content: text, by: { kind: "bot" }, ...(mid ? { mid } : {}) },
    ]);
  } catch (err) {
    void logSystemError("meta", `Личное по комментарию ${row.commentId} не записано в переписку: ${describeError(err)}`);
  }
}

/** Один шаг записи итога — чтобы шесть исходов не расползлись шестью разными
 *  наборами полей. */
async function finish(id: string, data: Record<string, unknown>): Promise<void> {
  // «Голос рынка» (03.10.2026): итог записывается во многих ветках, и часть ранних
  // выходов (повтор, спам, воронка, лимит ИИ) идёт ДО поиска объекта — propertyId
  // оставался пустым, и комментарий выпадал из картины по объекту. Для конечных
  // статусов добираем объект дешёвым путём по своей базе (без обращений к Meta);
  // уже найденный объект не трогаем. Сбой добора разбор не роняет.
  if (data.propertyId === undefined && typeof data.status === "string" && !TRANSIENT_STATUSES.has(data.status)) {
    const propertyId = await propertyIdForStoredComment(id);
    if (propertyId) data = { ...data, propertyId };
  }
  await prisma.instagramComment.update({ where: { id }, data });
}

/** Статусы «ещё в работе»: итога по комментарию нет, объект добирать рано. */
const TRANSIENT_STATUSES = new Set(["PENDING", "WORKING"]);

/**
 * КОНКУРЕНТ ПОД НАШИМ ПОСТОМ — РЕКЛАМА УДАЛЕНА, НОМЕР ОСТАЁТСЯ СЛЕДОМ
 * (владелец 05.09.2026).
 *
 * Комментарий уходит безвозвратно (см. deleteComment), но риелторы, рекламируя
 * свою квартиру, почти всегда сами пишут номер в тексте — это чей-то реальный
 * контакт на рынке недвижимости, просто не клиент, а конкурент. Заводим
 * карточку тем же путём, что и все автоматические лиды (createLeadFromChannel),
 * с kind=OTHER: она попадёт в «Прочие обращения» (видна только руководству,
 * агентам не раздаётся — см. enum ClientKind в schema.prisma) и толкнёт пуш
 * тем, у кого есть право otherInquiries.view, — без единой новой строчки кода
 * уведомлений, это уже делает сам createLeadFromChannel.
 *
 * БЕЗ НОМЕРА КАРТОЧКУ НЕ ЗАВОДИМ И НИКОГО НЕ УВЕДОМЛЯЕМ (явное решение
 * владельца 05.09.2026): Client.phone обязателен и уникален, выдуманный номер
 * подставлять нельзя, а обычного удаления комментария в этом случае достаточно.
 */
/** Экспортирована для Telegram-обсуждения (messengers/telegramGroupComments.ts):
 *  тот же номер из того же объявления обязан лечь в ту же карточку одинаково на
 *  всех площадках, а не второй, слегка другой копией. */
export async function createLeadFromCompetitorAd(
  row: Pick<QueuedComment, "channel" | "authorName" | "text" | "commentId">,
  kind: "OTHER" | "SELLER" = "OTHER"
): Promise<void> {
  const phones = extractAllPhones(row.text);
  if (phones.length === 0) return;
  /**
   * НОМЕР УЖЕ ЕСТЬ В БАЗЕ — ЭТО НЕ ОБРАЩЕНИЕ КЛИЕНТА (23.09.2026, разбор
   * раздачи, пункт 23). Через createLeadFromChannel номер знакомой карточки
   * запускал всю логику «клиент вернулся»: «Отложенного» досрочно в работу,
   * «Потерянного» в новые, неактивному предложение вернуть, пуш агенту «Ваш
   * клиент снова обратился», а непринятый лид покупателя переводил в «Прочее»
   * и снимал с агента. Клиент при этом ничего не писал нам — он (часто
   * риелтор, который у нас же и покупает) дал рекламу под нашим постом.
   * Оставляем только строку в хронологии, ничего не меняя в карточке.
   */
  const [known] = await findPhoneOwners(phones, { includeDeleted: true, limit: 1 });
  if (known) {
    if (!known.deletedAt) {
      await logTimeline({
        clientId: known.id,
        actor: { kind: "system", source: "ig-comment-spam", subjectAgentId: known.assignedAgentId ?? null },
        type: "SYSTEM",
        notes: `Номер клиента встретился в ${kind === "SELLER" ? "объявлении о продаже" : "рекламном комментарии"} под нашим постом: «${row.text.slice(0, 300)}»`,
      }).catch((err) =>
        logSystemError("meta", `Рекламный комментарий ${row.commentId}: запись в хронологию не сделана: ${describeError(err)}`)
      );
    }
    return;
  }
  const source: ClientSource =
    row.channel === "FACEBOOK" ? "FACEBOOK" : row.channel === "TELEGRAM" ? "TELEGRAM" : "INSTAGRAM";
  // Агенту — сразу и подходящие покупатели (номера карточек, без имён): звонит он
  // собственнику уже зная, что предложить (владелец 24.09.2026).
  const buyers =
    kind === "SELLER" ? await matchBuyersForListing(row.text).catch(() => null) : null;
  const where =
    row.channel === "YOUTUBE"
      ? "YouTube"
      : row.channel === "FACEBOOK"
        ? "Facebook"
        : row.channel === "TELEGRAM"
          ? "Telegram"
          : "Instagram";
  await createLeadFromChannel({
    fullName: row.authorName ? `@${row.authorName}` : `Комментатор ${where}`,
    phone: phones[0],
    extraPhones: phones.slice(1),
    source,
    kind,
    requirementsNotes:
      kind === "SELLER"
        ? `Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом (${where}). ` +
          `Написать ему в личку отсюда нельзя — позвонить и предложить продать через нас: «${row.text.slice(0, 500)}»` +
          (buyers ? `\n${describeBuyerMatch(buyers)}` : "")
        : `Рекламный комментарий под нашим постом (реклама чужой недвижимости): «${row.text.slice(0, 500)}»`,
    socialUsername: row.authorName ?? undefined,
    socialChannel: row.channel,
  });
}

/**
 * «Бот не знает» — зовём человека. Получатели по праву, а не по роли: право
 * «Сообщения» есть у директора и администратора, и именно они разбирают
 * переписку (см. lib/recipients.ts).
 */
async function escalate(row: QueuedComment, reason?: string): Promise<void> {
  try {
    const recipients = await findAgentsWithPermission("messages.view");
    const author = row.authorName ? `@${row.authorName}` : "Подписчик";
    const body = `${author}: «${row.text.slice(0, 120)}»${reason ? ` — ${reason.slice(0, 120)}` : ""}`;
    // Один запрос на всех получателей разом вместо sendPushToAgent на каждого
    // (N+1: столько запросов на подписки/тихие часы, сколько получателей права
    // messages.view), 22.09.2026.
    await sendPushToAgents(recipients, {
      title: "💬 Instagram: бот не знает ответа",
      body,
      url: "/messages",
      // Тег по комментарию: повторная попытка не должна давать второе
      // уведомление о том же самом.
      tag: `ig-comment-${row.commentId}`,
    });
  } catch (err) {
    void logSystemError("meta", `Эскалация по комментарию ${row.commentId} не отправлена: ${describeError(err)}`);
  }
}

/** Отказ обработки: пробуем ещё раз, а после трёх попыток зовём человека —
 *  бесконечные повторы молча съели бы комментарий. */
/** Ошибка «поставщик ИИ недоступен» — у неё свой, терпеливый путь повторов. */
class AiUnavailableError extends Error {}


/**
 * Комментарий правда удалён, или площадка отказала по другой причине (02.10.2026)?
 *
 * Текст «does not exist, cannot be loaded due to missing permissions, or does not
 * support this operation» Meta отдаёт ОДИН И ТОТ ЖЕ и на удалённый комментарий, и на
 * нехватку прав, и на неверный адрес. Всё это молча закрывалось как «удалён», и
 * ни отказ скрытия на Facebook без права pages_manage_engagement, ни ответ не по
 * тому адресу не доходили до «Здоровья системы». Спрашиваем сам комментарий:
 * читается — значит он жив, и это настоящая ошибка.
 */
async function commentStillExists(row: QueuedComment): Promise<boolean> {
  if (row.channel !== "INSTAGRAM" && row.channel !== "FACEBOOK") return false;
  try {
    const { url, token } = await commentApi(
      row.channel as MessengerChannel,
      `/${encodeURIComponent(row.commentId)}?fields=id`
    );
    const req = instagramRequest(url, token);
    const res = await fetchWithRetry(req.url, { headers: req.headers });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Скрыть или удалить, а отказ площадки записать, не обрывая ход (02.10.2026).
 * Без этого не удавшееся скрытие обрывало обработку ДО заведения карточки:
 * собственник не получал письма, номер из рекламы не ложился в «Прочее».
 * Возвращает подтверждение конкретной модерации; unknown не равен отказу или успеху.
 */
async function moderateOrNote(
  row: QueuedComment,
  action: "hide" | "delete",
  run: () => Promise<void>
): Promise<ModerationOutcome> {
  const provider = row.channel as ModerationProvider;
  const effect = provider === "YOUTUBE" ? "reject" : action;
  try {
    await run();
    return { provider, effect, outcome: "accepted", reason: "provider_confirmed" };
  } catch (err) {
    const result = moderationErrorOutcome(provider, effect, err);
    void logSystemError(
      provider === "YOUTUBE" ? "youtube" : "meta",
      `Площадка не подтвердила модерацию комментария ${row.channel} ${row.commentId}: ${result.outcome}/${result.reason}. ` +
        `Независимая обработка обращения продолжается; проверьте комментарий на площадке.`,
      { dedupKey: `comment-moderation:${row.channel}:${action}` }
    );
    return result;
  }
}

async function finishModeration(
  row: QueuedComment, result: ModerationOutcome, reason: string, propertyId?: string
): Promise<keyof CommentRunStats> {
  if (result.outcome !== "accepted") {
    await finish(row.id, { status: result.outcome === "gone" ? "FAILED" : "SKIPPED",
      note: `${reason}; ${moderationFailureNote(result)}`.slice(0, 200), propertyId });
    return "skipped";
  }
  const deleted = result.effect === "delete";
  await finish(row.id, { status: deleted ? "DELETED" : "HIDDEN", hiddenAt: new Date(),
    note: moderationAcceptedNote(result, reason), propertyId });
  return deleted ? "deleted" : "hidden";
}

async function failComment(row: QueuedComment, err: unknown): Promise<void> {
  if (isCommentGone(err) && !(await commentStillExists(row))) {
    // В журнал ошибок не пишем и человека не зовём: отвечать физически некуда.
    console.warn(`[comments] Комментарий ${row.commentId} удалён или недоступен — закрыт без ответа`);
    await finish(row.id, { status: "FAILED", note: "gone" });
    return;
  }
  void logSystemError("meta", `Комментарий Instagram ${row.commentId} не обработан: ${describeError(err)}`);
  // attempts уже увеличен при захвате, а в row лежит значение до него.
  const attempts = row.attempts + 1;

  /**
   * ИИ недоступен — комментарий НЕ хоронится (владелец 16.08.2026: «вопросы не
   * должны исчезать, бот пусть позже, но ответит»). Пауза растёт: 5м, 10м, 20м,
   * 40м, 80м, дальше по 4 часа — итого больше суток терпения. Повторы
   * продолжаются: кто успел первым, тот и ответил. Окно личного ответа Meta —
   * 7 суток, публичного — без срока, так что поздний ответ доставится.
   *
   * ОТДЕЛЬНЫЙ PUSH СЮДА БОЛЬШЕ НЕ ШЛЁМ (владелец 30.08.2026: «отключи, что у ИИ
   * типа нет ответа — думаю не надо такого»). Это ТЕХНИЧЕСКИЙ отказ модели, а не
   * решение бота передать реальный вопрос клиента человеку (см. ниже случай
   * `decision.action === "escalate"` — тот push остаётся: там модель сама решила,
   * что вопрос про документы/рассрочку/сделку ей не по силам, и это не сбой).
   * Директор всё равно узнаёт немедленно через logSystemError выше по функции
   * (source "meta", единый канал «Здоровье системы» — 20.08.2026).
   */
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

/** P12-backed public wire for the early managed adapter. No legacy fallback,
 * downstream DM, media/funnel action or guessed account is permitted here. */
export async function postManagedPublicCommentReply(
  principal: import("../lib/publicCommentSourceIssuer.js").PublicCommentPrincipal,
  text: string,
  options: { agentRevisionId?: string; publicReadWitness?: import("../lib/customerPublicDelivery.js").PublicCommentReadWitness;
    publicDataWitness?: import("../lib/customerAgentDeliveryEvidence.js").CustomerAgentDeliveryWitness } = {}
): Promise<string> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || (original.target.channel !== "INSTAGRAM" && original.target.channel !== "FACEBOOK")) {
    // YT token cache is not installation/epoch-bound yet. Never use its current/default OAuth session as a managed proof.
    throw new PublicReplyHeldError("managed_public_transport_unbound");
  }
  const token = await readPublicCommentMetaToken(principal.installation);
  if (!token) throw new PublicReplyHeldError("public_credentials_changed");
  const target = publicCommentWireTarget(original);
  const store = createCustomerPublicReplyStore({ principal, text, ...options });
  return withCustomerPublicDeliveryTrace(principal, () => sendRecordedPublicReply({ provider: original.target.channel, target,
    expectedSourceRevision: BigInt(original.sourceRevision), text, store,
    send: beforePost => postCommentReplyResponse({ channel: original.target.channel, commentId: original.target.commentId,
      parentId: original.target.parentId }, text, token, beforePost) }));
}
