import { customerDmRoutingForIncoming, inspectCustomerDmRouting } from "../lib/customerAgentIngressRouting.js";
import { createHash } from "node:crypto";
import type { CustomerPropertyAdmissionResult } from "@royal-home/shared";
import { customerPropertyContextEnabled } from "../lib/customerPropertyContextFlag.js";
import { admitCustomerPropertyInput } from "../lib/customerPropertyAdmission.js";
import { persistVerifiedCustomerIngressBatch } from "../lib/customerIngressProducer.js";
import { persistVerifiedMetaPublicCommentBatch } from "../lib/customerPublicCommentProducer.js";
import { captureAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest,
  registerAuthenticatedWebsiteCustomerRequest, initializeVerifiedCustomerEndpoint, verifyMetaCustomerReferralTarget, type AuthenticatedCustomerInput } from "../lib/customerIngressAuthority.js";
import { CustomerScopeDenied, customerTransportInput, findScopedBotConversation, resolveCustomerEndpoint, type CustomerTransportHint } from "../lib/customerConversationScope.js";
import { acceptAuthenticatedCustomerAdmission } from "../lib/customerState.js";
import { revalidateCustomerPrincipal } from "../lib/customerPrincipal.js";
import { CustomerReplyHeldError } from "../lib/customerReplyFence.js";
import { isFinalCustomerInputFrame } from "../lib/customerInputFrame.js";
import { reserveCustomerPropertyFocus } from "../lib/customerPropertyFocus.js";
import { verifyCustomerAccountSignature, verifyPublicCustomerAccountSignature } from "../messengers/meta.js";
import { customerPropertyEvidenceFromMeta } from "../lib/customerPropertyEvidence.js";
import { peekAdReferral, consumeAdReferral } from "../messengers/metaPeerMemory.js";
import { sendManagedCustomerPropertyReply } from "../lib/customerPropertyDelivery.js";
import { withBotTurnTrace, traceOutcome, traceEchoReason, traceDeferUntil, traceDeliveryStatus, traceResolution, traceFinishCustomerTurn } from "../lib/botTurnTrace.js";
import { Router } from "express";
import { detectSpam, sharedPostSpamContext } from "../lib/incomingSpam.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { ClientStatus, Prisma } from "../generated/prisma/client.js";
import { CLIENT_STATUS_LABELS } from "@royal-home/shared";
import { logTimeline } from "../lib/timeline.js";
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { matchesUniqueConstraint } from "../lib/prismaUniqueConflict.js";
import { fromTjs, loadMoneyContext, roundMoney } from "../lib/money.js";
import { closePendingPropertyDeleteRequests, closeTrashedPropertyWorkSatellites } from "../lib/trashProperty.js";
import { revokePropertyShareLinks } from "../lib/propertyShareLink.js";
import { createLeadFromChannel } from "../leads.js";
import { resolvePropertyFromPageUrl } from "../lib/resolvePropertyFromPageUrl.js";
import { classifyInbound } from "../services/leads/intakePolicy.js";
import {
  adTopicByExternalId,
  type AdTopic,
  clientSaidNothingSubstantive,
  isJobAdRef,
  neutralOpenerHint,
  sellerTurnHint,
  vacancyTurnHint,
} from "../ai/adTemplateOpener.js";
import { isVacancyPostCode } from "../lib/vacancyPosts.js";
import {
  appendConversationMessages,
  markLastReplyUndelivered,
  markMessageDeliveryStatus,
  processMessengerTurn,
  stampOutgoingMid,
  type MessengerChannel,
} from "../messengers/conversation.js";
import {
  instagramShortcode,
  isSharedPost,
  sharedMediaHint,
  sharedPostContext,
  adReferralPropertyId,
  silentOnForeignShare,
  clientTalksBusiness,
  isOurBrandCaption,
  captionSaysForeign,
} from "../messengers/sharedMedia.js";
import { rememberClientSharedPost } from "../messengers/clientSharedPosts.js";
import { isInstagramLink } from "../lib/instagramLink.js";
import { findOwnMedia, findOwnMediaById, viewableUrl } from "../messengers/ownMedia.js";
import { isMetaCdnUrl, readCardSource, readSharedCard } from "../messengers/sharedPostCard.js";
import {
  rememberAdReferral,
  takeAdReferral,
  rememberForeignShare,
  rememberSilentShare,
  recentSilentShare,
  recentForeignShare,
} from "../messengers/metaPeerMemory.js";
import {
  fetchInstagramProfile,
  fetchMessengerName,
  foreignWhatsAppPhoneIds as foreignMetaWaPhoneIds,
  getWaPhoneId as getMetaWaPhoneId,
  isMetaEnabled,
  parseIncoming as parseMetaIncoming,
  parseStatusUpdates as parseMetaStatusUpdates,
  sendMessage as sendMetaMessage,
  sendReaction as sendMetaReaction,
  showReadAndTyping as showMetaReadAndTyping,
  verifyHandshake as verifyMetaHandshake,
  verifySignature as verifyMetaSignature,
  whatsAppMediaSource,
  type MetaChannel,
} from "../messengers/meta.js";
import { emojiThanksReply, ingestInstagramComments, reactionHeart, RUDE_EMOJI } from "../messengers/comments.js";
import { resolveIncomingAccount } from "../messengers/accounts.js";
import { wasSentByUs } from "../messengers/outgoingMids.js";
import { isOwnInFlightEcho, type EchoHistoryEntry } from "../messengers/inFlightEcho.js";
import { isOwnCustomerOutboxEcho } from "../lib/customerOutboxEcho.js";
import { isOwnAccountSender, ownAccountPauseUntil } from "../lib/ownAccountGuard.js";
import { isOutboundBlockedError, noteRealInbound } from "../lib/outboundShield.js";
import { OPERATOR_ECHO_PAUSE_MS, applyDeliveryPause, deliverBotVoiceReply } from "../lib/conversationDelivery.js";
import {
  noteFirstContactDelivery,
  noteFirstContactReply,
  rememberBusinessAccountFromWebhook,
} from "../lib/whatsappFirstContact.js";
// «Человеческий ритм»: мгновенный ответ — главный поведенческий маркер бота и для
// клиента, и для антиспам-эвристик Meta. Значения общие с показом фотографий
// (messengers/humanPacing.ts): пока они лежали копией здесь, у показа объекта пауз
// не было вовсе, и три снимка уходили одним залпом.
import { sleep, typingDelayMs } from "../messengers/humanPacing.js";
import { loadBotChannelToggles } from "../messengers/botChannels.js";
import type { AttachmentSource } from "../messengers/attachments.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import {
  handleWebsiteChatTurn,
  isWebsiteChatEnabled,
  loadWebsiteChatMessages,
  recordWebsiteChatMessageOnly,
  WEBSITE_SESSION_RE,
} from "../messengers/websiteChat.js";
import { secretsMatch } from "../lib/secretCompare.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { uploadsDir } from "../upload.js";
import { publicUploadUrl } from "../lib/crmPublicUrl.js";
import { generateCoverImage } from "../ai/coverImage.js";
import { isReactionOnly } from "../ai/replyGuards.js";
import { looksLikeMoneyRequest } from "../ai/moneyRequestGuard.js";
import { screenIncomingText } from "../ai/inboundScreen.js";
import { isDuplicateDelivery, markProcessedMessageComplete, releaseProcessedMessage } from "../lib/webhookDedupe.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { leadMagnetSilencesBot, tryLeadMagnetMessage } from "../lib/leadMagnet.js";
import { isWithinWorkingHours } from "../lib/workingHours.js";
import { normalizeDigits } from "../ai/leadQualifier.js";
import { handleTelegramUpdate, isAlbumPart } from "../telegram/bot.js";
import type { TelegramUpdate } from "../telegram/api.js";
import { withTelegramUpdateRetry } from "../telegram/updateRetry.js";
import { anyParams } from "../lib/routeParams.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { sendPushToAgents } from "../push.js";
import { ensureMetaAdKnown } from "../lib/ads/syncMetaAds.js";

export const webhooksRouter = Router();

/**
 * Публичный приём заявок с сайта royalhome.tj. Аутентификация — общий секрет
 * X-Api-Key (env WEBSITE_LEAD_API_KEY), а не JWT: у сайта нет учётки агента,
 * это межсерверный вызов. Без настроенного ключа endpoint полностью выключен.
 */
const websiteLeadSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{7,20}$/, "Неверный формат телефона")
    // Регулярка считает символы, а не цифры: «-------» и «()()()()» проходили, а
    // normalizeDigits превращал их в «+», и все мусорные заявки сливались в одну
    // карточку с телефоном «+» (SYNC-02). Нижняя граница та же, что MIN_DIGITS в
    // lib/whatsappPhone.ts; верхнюю уже держит длина строки в регулярке (20 символов).
    .refine((v) => v.replace(/\D/g, "").length >= 7, "Неверный формат телефона"),
  comment: z.string().trim().max(2000).optional(),
  /// Название района из формы сайта (напр. "Сино") — маппится на District по имени.
  districtName: z.string().trim().max(100).optional(),
  rooms: z.coerce.number().int().min(1).max(20).optional(),
  budgetMin: z.coerce.number().positive().optional(),
  budgetMax: z.coerce.number().positive().optional(),
  /// Страница-источник (URL объекта на сайте) — попадает в заметки лида для контекста.
  pageUrl: z.string().trim().url().max(500).optional(),
});

/**
 * Заявки с сайта. Важно: все они приходят с ОДНОГО IP (сервер сайта), а не от
 * посетителей напрямую, поэтому лимит здесь — не антиспам по посетителям (его
 * держит сам сайт), а предохранитель от зациклившейся интеграции. Прежние 10/15 мин
 * означали, что 11-я настоящая заявка за четверть часа просто терялась.
 */
const leadWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много заявок, попробуйте позже" },
});

/**
 * Межсерверная синхронизация объектов/статусов: сайт шлёт по вебхуку на КАЖДОЕ
 * изменение, поэтому массовая правка каталога легко даёт десятки вызовов подряд.
 * Раньше эти роуты делили лимитер с заявками (10/15 мин на всех) и синк молча
 * упирался в 429 после десятого объекта. Доступ и так закрыт общим секретом X-Api-Key —
 * лимит здесь только страховка от бесконечного цикла.
 */
const syncWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов синхронизации, попробуйте позже" },
});

/**
 * ЧАТ НА САЙТЕ — ЛИМИТ ПО ПОСЕТИТЕЛЮ, А НЕ ПО IP (правка 22.09.2026).
 *
 * Чат и опрос виджета делили лимитер заявок: 120 запросов за 15 минут, ключ по
 * IP. Но схема межсерверная — все посетители приходят с ОДНОГО адреса сервера
 * сайта, — поэтому 120 означало потолок на весь сайт разом, а виджет ещё и
 * опрашивает ответ каждые несколько секунд. Два живых разговора выбирали его за
 * минуту, и дальше 429 получали все: и чат, и заявки с формы, запертые тем же
 * счётчиком. Ровно это уже чинили у Meta и Telegram — ключом по отправителю
 * (metaChatLimiter ниже); здесь отправитель — сессия виджета.
 *
 * Разные лимиты у письма и у опроса не прихоть: опрос по своей природе идёт
 * пачками, а писать человек физически не может 30 раз в минуту.
 */
function websiteChatSessionKey(req: import("express").Request): string | null {
  const fromBody = (req.body as { sessionId?: unknown })?.sessionId;
  const raw = typeof fromBody === "string" ? fromBody : req.params?.sessionId;
  return typeof raw === "string" && WEBSITE_SESSION_RE.test(raw) ? raw : null;
}

const websiteChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const session = websiteChatSessionKey(req);
    return session ? `site-chat:${session}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "Слишком много сообщений, подождите немного" },
  /** Молчащий 429 на живом посетителе — потерянный клиент, о котором никто не
   *  узнает. Тот же довод, что у metaChatLimiter ниже. */
  handler: async (req, res, _next, options) => {
    try {
      await logSystemError(
        "api",
        `Лимит чата на сайте: сессия ${websiteChatSessionKey(req) ?? "не определена (ключ по IP)"} ` +
          `превысила 30 сообщений/мин — сообщение отклонено (429).`,
        { dedupKey: "website-chat-rate-limit" }
      );
    } catch (err) {
      console.error("[webhooks] websiteChatLimiter logSystemError", err instanceof Error ? err.message : err);
    }
    res.status(options.statusCode).json(options.message);
  },
});

/** Опрос виджета: та же сессия, но частота своя — виджет спрашивает «что нового»
 *  каждые несколько секунд, пока вкладка открыта. */
const websiteChatPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const session = websiteChatSessionKey(req);
    return session ? `site-poll:${session}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "Слишком много запросов, подождите немного" },
});

/** Рабочее время для кнопки «Перезвоните мне»: публичный роут без ключа, и делить
 *  счётчик с заявками ему нельзя — всплеск проверок запирал бы приём заявок. */
const workingHoursLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: { error: "Слишком много запросов, попробуйте позже" },
});

/**
 * ПОВТОРНАЯ ДОСТАВКА ЗАЯВКИ С САЙТА — НЕ «ЕЩЁ ОДИН ИНТЕРЕС» (аудит 22.08.2026,
 * замок сделан постоянным 22.09.2026).
 *
 * У сайта нет встроенных ретраев, но админ вручную повторяет отправку при плохой
 * связи, и тот же самый вызов уходит второй раз. Карточка при этом не задваивается
 * (телефон уникален), а вот createLeadFromChannel трактует совпадение телефона как
 * повторное обращение: агенту прилетает лишний push, а в хронологию клиента ложится
 * запись о заявке, которой не было.
 *
 * До 22.09.2026 замком было 30-секундное ОКНО — тот же приём, что у
 * /site-listing-changed. Этого хватало на автоматический ретрай сайта, но не на
 * ручной: админ обычно замечает зависшую форму и жмёт «отправить» ещё раз не
 * мгновенно, а через минуту-другую — то есть уже вне окна, и вебхук пропускал
 * повтор насквозь как настоящую вторую заявку. Теперь замок постоянный — общий
 * lib/webhookDedupe.ts, тот же, что у мессенджеров: отметка живёт, пока обработка
 * не завершится успешно (markProcessedMessageComplete), а зависшая дольше
 * STALE_AFTER_MS (10 минут — процесс, скорее всего, упал) подхватывается заново.
 * Человек, честно оставивший НОВУЮ заявку (другой текст/район/бюджет) в любой
 * момент, по-прежнему проходит как раньше — ключ строится из содержимого заявки,
 * а не только из телефона.
 */
const WEBSITE_LEAD_CHANNEL = "WEBSITE_LEAD";

/** Ключ доставки: сама заявка целиком. Одинаковый набор полей от одного человека
 *  в пределах окна — это повтор отправки, а не новая заявка. */
function websiteLeadDeliveryKey(phone: string, data: z.infer<typeof websiteLeadSchema>): string {
  const canonical = JSON.stringify([
    phone,
    data.fullName,
    data.comment ?? "",
    data.districtName ?? "",
    data.rooms ?? "",
    data.budgetMin ?? "",
    data.budgetMax ?? "",
    data.pageUrl ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

webhooksRouter.post("/website-lead", leadWebhookLimiter, async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Приём заявок с сайта не настроен" });
  }
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }

  const parsed = websiteLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные заявки", details: parsed.error.flatten() });
  }
  const data = parsed.data;

  // Нормализуем номер тем же правилом, что и бот (normalizeDigits): 9 цифр →
  // +992XXXXXXXXX. Дедупликация лидов в createLeadFromChannel работает по точному
  // совпадению phone, а форма сайта присылала «937 001 122» → «937001122», тогда как
  // из мессенджера тот же человек приходил как «+992937001122» — и заводились две
  // карточки, часто на двух разных агентов, с делением комиссии между ними.
  const phone = normalizeDigits(data.phone.replace(/[^\d]/g, ""));

  // Повтор той же отправки (постоянный замок — см. комментарий у WEBSITE_LEAD_CHANNEL
  // выше): отвечаем так же, как первая доставка на уже существующего клиента, —
  // сайт получает тот же clientId и ничего не замечает. Если карточки почему-то нет
  // (первая доставка не довела дело до конца или сама ещё выполняется), обрабатываем
  // заявку обычным путём: потерять её хуже, чем изредка обработать дважды.
  const leadDeliveryKey = websiteLeadDeliveryKey(phone, data);
  if (await isDuplicateDelivery(WEBSITE_LEAD_CHANNEL, leadDeliveryKey)) {
    const already = await prisma.client.findUnique({ where: { phone }, select: { id: true, deletedAt: true } });
    // Карточка в Корзине — тоже «не довели до конца»: заявку надо обработать, чтобы
    // createLeadFromChannel достала клиента из Корзины (см. resumeExistingChannelLead).
    if (already && !already.deletedAt) return res.status(200).json({ ok: true, created: false, clientId: already.id });
  }

  // Одно правило поиска района на все каналы (lib/districtLookup.ts, 24.09.2026).
  const districtId = await findDistrictIdByName(data.districtName);

  /**
   * ТИП ЗАЯВКИ С САЙТА — С ТЕМИ ЖЕ ОТСЕЧКАМИ, ЧТО У БОТА (разбор 30.08.2026).
   *
   * `kind` здесь не передавался вовсе, и в services/leads/intake.ts срабатывало
   * умолчание «покупатель»: форма сайта была вторым (после Telegram) путём в
   * обход всех проверок — комментарий «продам участок в Вахдате» становился
   * обычным лидом и уходил живому агенту.
   *
   * fallbackKind=BUYER, и это осознанно: форму подбора человек заполняет сам,
   * никакой модели тут нет, и «намерение не определено» означало бы, что главный
   * канал заявок перестал раздаваться агентам. Отсечки при этом работают — они
   * читают комментарий клиента (ai/leadKind.ts).
   */
  // П-13 (18.09.2026): через intakePolicy.classifyInbound — channel:"site_form"
  // сам даёт fallbackKind=BUYER (та же логика, что раньше передавалась явно).
  const decision = classifyInbound({
    clientText: data.comment ?? "",
    budgetMin: data.budgetMin,
    budgetMax: data.budgetMax,
    channel: "site_form",
  });
  if (decision.kind === "OTHER" && decision.reason) {
    void logSystemError(
      "ai",
      `Заявка с сайта заведена как «прочее обращение»: ${decision.reason}. Агенту не назначается. ` +
        `Комментарий: «${(data.comment ?? "").replace(/\s+/g, " ").slice(0, 160)}»`
    );
  }

  const notesParts = [decision.label, data.comment, data.pageUrl ? `Со страницы: ${data.pageUrl}` : undefined].filter(
    Boolean
  );

  // ОБЪЕКТ НАЗВАН ЯВНО (Пачка 1 п.5, 11.09.2026): заявка отправлена со страницы
  // конкретного объекта — лид уходит его хозяину безусловно, выше показа бота
  // и совпадения по описанию (см. lib/siteListingUrl.ts, LeadAssignContext.propertyId).
  const pageUrlPropertyId = await resolvePropertyFromPageUrl(data.pageUrl);

  let clientId: string;
  let created: boolean;
  try {
    ({ clientId, created } = await createLeadFromChannel({
      fullName: data.fullName,
      phone,
      source: "WEBSITE",
      kind: decision.kind,
      budgetMin: data.budgetMin,
      budgetMax: data.budgetMax,
      desiredDistrictId: districtId,
      desiredRooms: data.rooms,
      requirementsNotes: notesParts.length > 0 ? notesParts.join("\n") : undefined,
      propertyId: pageUrlPropertyId ?? undefined,
      // Заявка с сайта тоже приходит круглосуточно — вне рабочих часов ждёт утреннюю
      // волну распределения, как и лиды из бота (см. lib/workingHours.ts).
      deferAssignment: !(await isWithinWorkingHours()),
    }));
  } catch (err) {
    // Обработка сорвалась — снимаем замок немедленно, а не ждём STALE_AFTER_MS:
    // честный повтор (сайт или админ пришлют заявку снова) обязан пройти сразу.
    void releaseProcessedMessage(WEBSITE_LEAD_CHANNEL, leadDeliveryKey);
    throw err;
  }

  // Повторная заявка существующего клиента — не дубль, а сигнал интереса. Запись
  // в хронологию и push закреплённому агенту делает сама createLeadFromChannel
  // (leads.ts) — тем же путём для всех каналов сразу, а не только для сайта, как
  // было раньше: до 11.08.2026 повторное обращение из бота/Telegram проходило
  // совсем молча, и только у сайта была своя отдельная (и без push) запись.
  void markProcessedMessageComplete(WEBSITE_LEAD_CHANNEL, leadDeliveryKey);

  // clientId — чтобы сайт мог сохранить у себя связь заявка↔клиент CRM и потом
  // синхронизировать статус в обе стороны (см. /site-lead-status ниже).
  res.status(created ? 201 : 200).json({ ok: true, created, clientId });
});

/**
 * ЧАТ НА САЙТЕ (владелец 23.08.2026). Два вызова, оба межсерверные: браузер
 * посетителя ходит на свой сайт, сайт — сюда с общим секретом. Ключ у CRM тот же,
 * что и у заявок (WEBSITE_LEAD_API_KEY): это одна и та же интеграция с одним
 * доверенным сервером, а второй секрет означал бы второй способ его потерять.
 *
 *  POST /website-chat          — посетитель написал, отвечает бот;
 *  GET  /website-chat/:session — что нового (ответ бота и реплики живого агента).
 *
 * Механика канала — в messengers/websiteChat.ts; здесь только проверка входа.
 */
export const websiteChatSchema = z.object({
  sessionId: z.string().regex(WEBSITE_SESSION_RE, "Неверный идентификатор сессии"),
  // Тот же потолок, что у сообщений мессенджеров: длинным текстом можно вытеснить
  // из промта правила поведения (см. MAX_UNTRUSTED_CHARS в conversation.ts).
  text: z.string().trim().min(1, "Пустое сообщение").max(2000),
  name: z.string().trim().max(120).optional(),
  // Адрес страницы — только настоящий URL (как у /website-lead): иначе произвольный текст
  // из поля попадал в подсказку боту (ночная проверка 24.09.2026, №134). Не URL —
  // поле просто отбрасывается, а сообщение клиента принимается: виджет живёт в
  // другом репозитории, и отказ 400 из-за служебного поля оборвал бы весь чат.
  pageUrl: z.string().trim().url().max(500).optional().catch(undefined),
  /**
   * Идентификатор сообщения на стороне сайта — НЕОБЯЗАТЕЛЬНЫЙ, и это временно.
   * Виджет его пока не шлёт; как только начнёт, повтор доставки будет узнаваться
   * точно, а не по совпадению текста (см. websiteChatDeliveryKey ниже).
   */
  messageId: z.string().trim().max(200).optional(),
});

/**
 * ПОВТОРНАЯ ДОСТАВКА СООБЩЕНИЯ ИЗ ЧАТА НА САЙТЕ — ЭТО ДВА ОТВЕТА ПОСЕТИТЕЛЮ.
 *
 * У всех остальных каналов есть устойчивый id события (update_id у Telegram, mid
 * у Meta, messageId у Pub/Sub), и общий замок lib/webhookDedupe.ts работает по
 * нему. У чата на сайте такого id нет вовсе, и до 22.09.2026 проверки не было
 * никакой: ретрай сайта после обрыва связи клал реплику посетителя в переписку
 * ВТОРОЙ раз и запускал второй независимый ход бота. Ровно это чинили 23.08.2026
 * (см. большой комментарий у обработчика ниже), но только со стороны «не держать
 * HTTP-соединение» — со стороны ключа дыра осталась.
 *
 * Ключ — та же заявка целиком, что у /website-lead: одинаковый текст из одной
 * сессии в пределах окна это повтор отправки, а не новая реплика.
 *
 * Окно КОРОЧЕ, чем у заявок (15 с против 30): цена ошибки здесь обратная. У
 * заявки лишний повтор — лишний push агенту, а съеденная реплика в чате — это
 * вопрос посетителя, на который никто не ответил. Пятнадцати секунд хватает на
 * ретрай сайта с запасом, а живой человек, повторивший то же слово позже, будет
 * услышан. Если посетитель напишет «да» дважды внутри этих секунд, второе «да»
 * не пропадёт по смыслу: короткие сообщения подряд всё равно склеиваются в один
 * ход дебаунсом (debounceAndMerge в conversation.ts).
 *
 * ЗАМОК ПЕРЕСМОТРЕН 22.09.2026. Ход бота — фоновый (см. res.json(...) до
 * trackBackgroundTask ниже): раньше отметка ставилась и тут же жила окном
 * WEBSITE_CHAT_DEDUPE_MS, никак не привязанным к тому, идёт ли ход ещё. Два
 * живых разрыва:
 *   1) повтор ПОЗЖЕ окна, пока фоновый ход ещё выполняется (дебаунс + вызов
 *      модели легко занимают больше 15 с) — старое окно уже истекло, повтор
 *      проходил как новое сообщение, и запускался ВТОРОЙ независимый ход;
 *   2) ход упал — отметку никто не снимал (`isRepeatDelivery` не знала ни
 *      release, ни completedAt), и честный ретрай сайта В ОКНЕ съедался молча,
 *      без ответа посетителю вовсе.
 * Теперь замок — общий lib/webhookDedupe.ts: отметка ставится до постановки
 * хода в очередь, `completedAt` — по завершении САМОГО ХОДА (а не по ответу
 * виджету), а падение хода снимает отметку немедленно. Короткое окно НЕ ушло —
 * для реплик без своего messageId (виджет пока не шлёт id) его держит
 * isWebsiteChatRepeat: завершённая отметка старше WEBSITE_CHAT_DEDUPE_MS
 * снимается, так что то же слово из той же сессии позже воспринимается как новая
 * реплика, а не вечный дубль (иначе «да», сказанное дважды с разницей в час,
 * отбрасывалось бы навсегда). До 01.10.2026 окно было «бакетом» времени в самом
 * ключе — и повтор на границе двух бакетов проходил насквозь (№133).
 */
const WEBSITE_CHAT_DEDUPE_MS = 15_000;
const WEBSITE_CHAT_CHANNEL = "WEBSITE_CHAT_DELIVERY";

function websiteChatDeliveryKey(data: z.infer<typeof websiteChatSchema>): string {
  // Свой id сайта, если он есть, точнее любого хэша — совпадение текста им не
  // подменяется, а дополняется, и замок держится, пока ход не завершится или не
  // упадёт, без окна по времени: настоящий id не повторится у двух разных реплик.
  if (data.messageId) return `mid:${data.sessionId}:${data.messageId}`;
  // Без id — ключ по содержимому, БЕЗ времени в ключе. Раньше сюда входил «бакет»
  // Math.floor(Date.now() / 15 с): повтор на границе двух бакетов (14,9-я секунда и
  // 300 мс спустя) получал другой ключ и проходил как новая реплика — два ответа
  // посетителю (ночная проверка 01.10.2026, №133). Окно теперь считает
  // isWebsiteChatRepeat — от начала первой доставки, без границ.
  const canonical = JSON.stringify([data.sessionId, data.text, data.name ?? "", data.pageUrl ?? ""]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Повтор доставки или нет. Реплика с id сайта — решает сам замок. Реплика без id:
 * завершённая отметка по тому же содержимому старше окна WEBSITE_CHAT_DEDUPE_MS
 * снимается — то же слово, сказанное позже, это новая реплика, а не вечный дубль;
 * незавершённая (ход ещё идёт) и свежая остаются дублем.
 */
async function isWebsiteChatRepeat(data: z.infer<typeof websiteChatSchema>, key: string): Promise<boolean> {
  if (!data.messageId) {
    await prisma.processedMessage
      .deleteMany({
        where: {
          channel: WEBSITE_CHAT_CHANNEL,
          messageId: key,
          completedAt: { not: null },
          createdAt: { lt: new Date(Date.now() - WEBSITE_CHAT_DEDUPE_MS) },
        },
      })
      .catch((err) => console.error("[webhook] устаревшая отметка чата не снята:", err instanceof Error ? err.message : err));
  }
  return isDuplicateDelivery(WEBSITE_CHAT_CHANNEL, key);
}

/**
 * РАБОЧЕЕ ЛИ СЕЙЧАС ВРЕМЯ — для кнопки «Перезвоните мне» на сайте (23.08.2026,
 * решение владельца). В рабочее время кнопка обещает скорый звонок и показывает
 * анимацию соединения; вне рабочего времени — честно принимает заявку как обычно,
 * без обещания звонка сию минуту. Час у CRM в базе (Settings.workHoursStart/End,
 * часовой пояс Душанбе), сайт своего понятия о рабочем времени не имеет и не
 * должен: держать копию расписания на двух серверах — верный способ развести их
 * молча, стоит владельцу один раз поправить часы в Настройках.
 *
 * Публичный без ключа: сам факт «сейчас рабочее время» не секрет, а требовать
 * X-Api-Key ради него означало бы либо палить ключ в браузере, либо городить
 * прокси на сайте только под один булев ответ.
 */
webhooksRouter.get("/website-working-hours", workingHoursLimiter, async (_req, res) => {
  try {
    res.json({ withinWorkingHours: await isWithinWorkingHours() });
  } catch {
    // Отказ базы — не повод ронять кнопку на сайте: честнее промолчать про рабочее
    // время (кнопка пойдёт по пути «вне часов», то есть просто примет заявку).
    res.json({ withinWorkingHours: false });
  }
});

webhooksRouter.post("/website-chat", websiteChatLimiter, async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Чат на сайте не настроен" });
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }
  const parsed = websiteChatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  registerAuthenticatedWebsiteCustomerRequest(req);
  const durableIngress = await persistVerifiedCustomerIngressBatch(req);
  if (durableIngress.status === "denied" || durableIngress.status === "unavailable") {
    return res.status(503).json({ error: "Сообщение пока не сохранено. Повторите отправку." });
  }
  const authenticatedInput = parsed.data.messageId ? captureAuthenticatedCustomerInput(req, { channel: "WEBSITE",
    peer: parsed.data.sessionId, eventId: parsed.data.messageId, eventKind: "website_message", inputText: parsed.data.text }) : null;

  /**
   * Повтор доставки (см. комментарий у WEBSITE_CHAT_DEDUPE_MS выше). Отвечаем
   * виджету так же, как на настоящее сообщение: для него это тот же самый вызов,
   * и ошибка здесь заставила бы его ретраить дальше. Просто не делаем работу
   * второй раз.
   */
  const chatDeliveryKey = websiteChatDeliveryKey(parsed.data);
  return withBotTurnTrace({ channel: "WEBSITE", peer: parsed.data.sessionId, source: "website", event: chatDeliveryKey,
    text: parsed.data.text, knownContacts: parsed.data.name ? [parsed.data.name] : [] }, async () => {
  if (await isWebsiteChatRepeat(parsed.data, chatDeliveryKey)) {
    traceOutcome("duplicate");
    return res.json({ ok: true, messages: [], accepted: false });
  }

  /**
   * Бот в чате на сайте выключен (Настройки → Бот). Сообщение посетителя всё равно
   * доходит до CRM и ложится в переписку — ровно как в выключенном канале Meta:
   * агент видит его в инбоксе и отвечает сам. Виджету отвечаем без реплик и с
   * признаком `botOff`, чтобы он показал честное «мы получили, ответим», а не
   * «печатает…» от имени бота, которого нет.
   */
  if (!(await isWebsiteChatEnabled())) {
    traceOutcome("bot_off");
    try {
      await recordWebsiteChatMessageOnly({ ...parsed.data, authenticatedInput: authenticatedInput ?? undefined });
      void markProcessedMessageComplete(WEBSITE_CHAT_CHANNEL, chatDeliveryKey);
      return res.json({ ok: true, messages: [], botOff: true });
    } catch (err) {
      void releaseProcessedMessage(WEBSITE_CHAT_CHANNEL, chatDeliveryKey);
      void logSystemError("api", `Чат на сайте: сообщение не записано: ${describeError(err)}`);
      return res.status(502).json({ error: "Не удалось принять сообщение" });
    }
  }

  /**
   * ОТВЕЧАЕМ СРАЗУ, НЕ ДОЖИДАЯСЬ ХОДА (найдено 23.08.2026 на живом сайте: чат
   * «зависал» и иногда отвечал дважды с двумя «Здравствуйте»).
   *
   * Ход идёт через тот же дебаунс, что и у мессенджеров (debounceAndMerge в
   * conversation.ts): несколько коротких сообщений подряд специально ждут друг
   * друга до `botReplyDelaySec` (по умолчанию секунды, потолок — до полутора
   * минут), прежде чем склеиться в один ответ. Для Meta это не проблема — вебхук
   * отвечает `{ok:true}` МГНОВЕННО (см. webhooksRouter.post("/meta", …) выше), а
   * сам ответ клиенту уходит позже отдельным вызовом Graph API. Этот же обработчик
   * ждал ход СИНХРОННО внутри HTTP-ответа виджету — то есть держал соединение
   * открытым на всё время дебаунса плюс вызов модели. Если браузер, прокси или
   * мобильная сеть рвали такое долгое соединение раньше срока, посетитель видел
   * зависшее «печатает…», а ход на сервере ПРОДОЛЖАЛ идти и дописывал ответ в
   * диалог сам по себе. Нетерпеливый повторный вопрос запускал ВТОРОЙ независимый
   * ход — оба ответа, включая приветствие, рано или поздно всплывали в опросе
   * виджета разом, как будто бот ответил дважды.
   *
   * Лечение — тот же приём, что у Meta: подтверждаем приём сразу, ход отправляем
   * в фон. Виджет ответ бота узнаёт ТОЛЬКО опросом (GET ниже) — то есть ровно так
   * же, как получает и реплики живого агента, подхватившего диалог из CRM.
   */
  res.json({ ok: true, messages: [], accepted: false });
  // Тот же класс потерь, что у /telegram и /meta (21.09.2026): без регистрации
  // в реестре остановки ход бота в чате сайта обрывался на полуслове при
  // рестарте, а виджет опросом никогда не узнавал, что ответа не будет.
  //
  // ЗАВЕРШЕНИЕ ЗАМКА — ПО ХОДУ, А НЕ ПО ОТВЕТУ ВИДЖЕТУ (22.09.2026). Ответ выше
  // уходит мгновенно, а сам ход идёт в фоне и может занять больше времени, чем
  // окно дедупа. Отметку завершаем ТОЛЬКО когда ход реально закончился успешно —
  // до этого момента честная повторная доставка (сайт не дождался ответа)
  // видит «ещё идёт» и не запускает второй ход. Падение хода снимает замок
  // немедленно, а не ждёт STALE_AFTER_MS: иначе ретрай сайта в это время был бы
  // молча съеден, хотя ответа посетитель так и не получил.
  const traceBackgroundTask = trackBackgroundTask(
    handleWebsiteChatTurn({ ...parsed.data, authenticatedInput: authenticatedInput ?? undefined })
      .then(() => {
        void markProcessedMessageComplete(WEBSITE_CHAT_CHANNEL, chatDeliveryKey);
      })
      .catch((err) => {
        traceOutcome("failed");
        void releaseProcessedMessage(WEBSITE_CHAT_CHANNEL, chatDeliveryKey);
        return logSystemError("api", `Чат на сайте: ход не обработан: ${describeError(err)}`);
      })
  );
  traceDeferUntil(traceBackgroundTask);
  });
});

webhooksRouter.get("/website-chat/:sessionId", anyParams(websiteChatPollLimiter), async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Чат на сайте не настроен" });
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }
  if (!WEBSITE_SESSION_RE.test(req.params.sessionId)) {
    return res.status(400).json({ error: "Неверный идентификатор сессии" });
  }
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  try {
    res.json(await loadWebsiteChatMessages(req.params.sessionId, after));
  } catch (err) {
    void logSystemError("api", `Чат на сайте: чтение диалога: ${describeError(err)}`);
    res.status(502).json({ error: "Не удалось прочитать диалог" });
  }
});

/**
 * Сайт-админка может свободно редактировать/удалять объект (в т.ч. пришедший из CRM) —
 * раньше CRM об этом никогда не узнавала. Сайт зовёт этот вебхук после каждого
 * изменения/удаления объекта с externalId (т.е. управляемого из CRM). Тот же паттерн,
 * что /website-lead: общий секрет X-Api-Key, без него выключено полностью.
 */
const siteListingChangedSchema = z.object({
  externalId: z.guid(),
  action: z.enum(["updated", "deleted"]),
  changes: z.record(z.string(), z.unknown()).optional(),
  editedBy: z.string().max(200).optional(),
});

/**
 * notifyCrmOfListingChange на сайте — fire-and-forget с 5-секундным таймаутом без
 * встроенных ретраев, но админ сайта может вручную повторить сохранение при плохой
 * связи, и тот же самый вызов уйдёт второй раз. Без дедупликации лента правок в CRM
 * зарастает дублями одного события.
 *
 * ЗАМОК СДЕЛАН ПОСТОЯННЫМ 22.09.2026. Раньше дублем считался только повтор В ОКНЕ
 * 30 секунд (сравнение содержимого `changes` с последней записью не старше окна) —
 * этого хватало на автоматический повтор сайта при обрыве связи, но не на ручной:
 * админ, заметивший зависшую форму, обычно жмёт «сохранить» ещё раз не мгновенно, а
 * когда вернётся к экрану — то есть уже вне окна. Тогда повтор проходил насквозь как
 * новая правка, и директор в ленте «Изменения на сайте» видел одно и то же событие
 * дважды. Теперь замок — общий lib/webhookDedupe.ts, тот же, что у остальных
 * вебхуков: ключ строится из содержимого доставки (объект + действие + правки), и
 * отметка живёт, пока обработка не завершится (а зависшая дольше STALE_AFTER_MS
 * подхватывается заново, как у мессенджеров). Устойчивого id у самой доставки сайт
 * не присылает, поэтому ключ — по содержимому, как у /website-lead: РАЗНАЯ правка
 * того же объекта (другой набор `changes`) по-прежнему заводит новое событие.
 *
 * Замок теперь и есть арбитр гонки параллельных доставок (унаследовано от
 * lib/webhookDedupe.ts — уникальность в БД, а не проверка «есть ли уже»): отдельная
 * блокировка строки объекта (`FOR UPDATE`), которая раньше стояла здесь и в
 * /site-listing-upserted (ветка deleted) специально под эту гонку, больше не нужна.
 */
const SITE_LISTING_CHANGE_CHANNEL = "SITE_LISTING_CHANGED";

function siteListingChangeDeliveryKey(externalId: string, action: string, changesData: unknown): string {
  return createHash("sha256").update(JSON.stringify([externalId, action, changesData ?? null])).digest("hex");
}

webhooksRouter.post("/site-listing-changed", syncWebhookLimiter, async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Не настроено" });
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }

  const parsed = siteListingChangedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { externalId, action, changes, editedBy } = parsed.data;

  const property = await prisma.property.findUnique({ where: { id: externalId } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });

  const changesData = changes || editedBy ? { ...changes, editedBy } : undefined;

  const deliveryKey = siteListingChangeDeliveryKey(externalId, action, changesData);
  if (await isDuplicateDelivery(SITE_LISTING_CHANGE_CHANNEL, deliveryKey)) {
    // Тот же ответ, что и у настоящей обработки: сайт получает 201 в обоих случаях
    // и не отличает повтор от первой доставки — ему это и не нужно знать.
    return res.status(201).json({ ok: true, duplicate: true });
  }

  try {
    // Обе записи в одной транзакции: порознь отказ на полпути оставлял уведомление
    // о правке без снятого publishedOnSite (или наоборот) — карточка в CRM начинала
    // расходиться с тем, что реально произошло на сайте, а разошедшееся никто не чинит.
    await prisma.$transaction(async (tx) => {
      await tx.siteEditNotification.create({
        data: { propertyId: property.id, action: action.toUpperCase(), changes: changesData },
      });

      // Удалён на сайте — там объекта больше нет, флаг публикации в CRM должен это отражать,
      // иначе кнопка "Снять с публикации" вводит в заблуждение (нечего снимать).
      if (action === "deleted" && property.publishedOnSite) {
        await tx.property.update({ where: { id: property.id }, data: { publishedOnSite: false } });
      }
    });
  } catch (err) {
    void releaseProcessedMessage(SITE_LISTING_CHANGE_CHANNEL, deliveryKey);
    throw err;
  }
  void markProcessedMessageComplete(SITE_LISTING_CHANGE_CHANNEL, deliveryKey);

  res.status(201).json({ ok: true });
});

/**
 * Сайт-админка меняет статус заявки в своём списке (не в CRM) — этот вебхук
 * применяет ту же смену статуса к соответствующему клиенту в CRM. Тот же
 * ключ, что /website-lead. Пишем клиента напрямую (не через PATCH /clients/:id),
 * иначе notifySiteLeadStatus() тут же отправила бы уведомление обратно на
 * сайт и получился бы бесконечный пинг-понг между системами.
 */
const siteLeadStatusSchema = z.object({
  clientId: z.guid(),
  status: z.enum(["new", "contacted", "closed"]),
});

const SITE_STATUS_TO_CRM = {
  new: "NEW",
  contacted: "CONTACTED",
  closed: "ARCHIVED",
} as const;

/**
 * КАКУЮ СМЕНУ СТАТУСА С САЙТА ПРИНИМАТЬ (аудит 23.09.2026, №48).
 *
 * Сайт знает о клиенте три слова: новый, на связи, закрыт. Раньше CRM
 * переписывала статус вслепую: «горячий» клиент агента становился «новым», а
 * сделка — «на связи». Теперь: карточку из Корзины и конечные статусы (потерян,
 * сделка, архив) сайт не трогает; «новый» и «на связи» только поднимают статус с
 * «нового», но никогда не понижают. Возвращает статус для записи или null.
 */
export function siteLeadStatusToApply(
  client: { status: ClientStatus; deletedAt: Date | null },
  fromSite: ClientStatus,
): ClientStatus | null {
  if (client.deletedAt) return null;
  if (client.status === fromSite) return null;
  if (client.status === "LOST" || client.status === "DEAL_CLOSED" || client.status === "ARCHIVED") return null;
  if (fromSite === "ARCHIVED") return fromSite;
  return client.status === "NEW" ? fromSite : null;
}

webhooksRouter.post("/site-lead-status", syncWebhookLimiter, async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Не настроено" });
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }

  const parsed = siteLeadStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { clientId, status } = parsed.data;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, status: true, deletedAt: true, assignedAgentId: true },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });

  const crmStatus = siteLeadStatusToApply(client, SITE_STATUS_TO_CRM[status]);
  let applied = false;
  if (crmStatus) {
    await prisma.$transaction(async (tx) => {
      // Решение принято по снимку, прочитанному выше: пока шёл разбор, агент мог
      // перевести клиента в HOT или закрыть сделку, а UPDATE по одному id перетёр бы
      // это (SYNC-03). Пишем только если статус и корзина всё ещё как в снимке.
      const written = await tx.client.updateMany({
        where: { id: clientId, status: client.status, deletedAt: null },
        data: { status: crmStatus },
      });
      if (written.count !== 1) return;
      applied = true;
      await logTimeline({
        clientId,
        actor: { kind: "system", source: "siteLeadStatus", subjectAgentId: client.assignedAgentId },
        type: "STATUS_CHANGE",
        notes: `Статус изменён с сайта: «${CLIENT_STATUS_LABELS[client.status]}» → «${CLIENT_STATUS_LABELS[crmStatus]}»`,
        tx,
      });
    });
  }

  res.status(200).json({ ok: true, applied });
});

// ─── Обратный синк объектов сайт→CRM ────────────────────────────────────────
// Объект, СОЗДАННЫЙ в админке сайта (без externalId из CRM), сайт присылает сюда,
// а CRM заводит/обновляет у себя такой же объект. Связь — по siteListingId
// (идемпотентный upsert). Незаполненные/неточные поля (район и т.п.) админ
// доправляет в CRM вручную — редактирование объекта есть.

const siteListingUpsertSchema = z.object({
  siteListingId: z.number().int().positive(),
  action: z.enum(["upserted", "deleted"]),
  title: z.string().optional(),
  location: z.string().optional(),
  price: z.number().nonnegative().optional(),
  rooms: z.number().int().nonnegative().optional(),
  area: z.number().positive().optional(),
  floor: z.string().optional(),
  totalFloors: z.number().int().optional(),
  category: z.enum(["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"]).optional(),
  type: z.string().optional(),
  repair: z.string().optional(),
  description: z.string().optional(),
  mapAddress: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  imageUrls: z.array(z.string()).optional(),
  editedBy: z.string().max(200).optional(),
});

/** Определяет район CRM по строке адреса сайта. Возвращает matched=false, если
 * совпадения нет — тогда используем первый район как заглушку, а к адресу
 * добавляем «(проверьте район)». */
/** Экспортируется для /site-notifications: "Принять" правку сайта (action UPDATED)
 *  должен матчить название района той же логикой, что и приём объектов сайта здесь —
 *  без дубля кода. */
export function resolveDistrict(location: string, districts: { id: string; name: string }[]): { id: string; matched: boolean } {
  const norm = location.toLowerCase();
  for (const d of districts) {
    if (norm.includes(d.name.toLowerCase())) return { id: d.id, matched: true };
  }
  // «И. Сомони» на сайте = «Исмоили Сомони» в CRM
  if (norm.includes("сомони")) {
    const m = districts.find((d) => d.name.toLowerCase().includes("сомони"));
    if (m) return { id: m.id, matched: true };
  }
  return { id: districts[0]?.id ?? "", matched: false };
}

/** Маппинг ремонта/типа сайта в состояние объекта CRM. */
function mapCondition(repair?: string, type?: string): "NEEDS_REPAIR" | "GOOD" | "EXCELLENT" | "NEW_BUILDING" {
  if (type === "Новостройки") return "NEW_BUILDING";
  const r = (repair ?? "").toLowerCase();
  if (/евро|новый ремонт/.test(r)) return "EXCELLENT";
  if (/без ремонта|разреш/.test(r)) return "NEEDS_REPAIR";
  return "GOOD";
}

/** Нарушение уникальности siteListingId: другая параллельная доставка того же
 *  вебхука успела создать объект первой (тот же приём, что isPhoneConflict в leads.ts). */
function isSiteListingConflict(err: unknown): boolean {
  return matchesUniqueConstraint(err, "siteListingId");
}

webhooksRouter.post("/site-listing-upserted", syncWebhookLimiter, async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Не настроено" });
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }

  const parsed = siteListingUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const existing = await prisma.property.findUnique({ where: { siteListingId: d.siteListingId } });

  if (d.action === "deleted") {
    // Мягкое удаление, как и у обычного DELETE /properties/:id: объект уходит в
    // Корзину и снимается с публикации. Физический delete здесь стирал карточку
    // безвозвратно в обход Корзины — и падал бы с ошибкой внешнего ключа, если по
    // объекту уже была заведена сделка. Решение «удалить навсегда» остаётся за
    // директором в CRM, а не за админкой сайта.
    if (existing && !existing.deletedAt) {
      /**
       * ЗАМОК ПЕРЕСМОТРЕН 22.09.2026 (тот же класс, что у /site-listing-changed).
       * Было: `FOR UPDATE` строки объекта + 30-секундное окно на содержимое ленты
       * — держало только гонку двух ПОЧТИ ОДНОВРЕМЕННЫХ доставок, а не повтор
       * позже окна (хотя после первого успеха `existing.deletedAt` уже стоит, и
       * ЛЮБАЯ следующая доставка отсекается ИМ — так что настоящая дыра тут была
       * только внутри окна гонки, и её закрывал `FOR UPDATE`).
       *
       * Теперь — общий постоянный замок lib/webhookDedupe.ts, тот же приём, что у
       * /site-listing-changed, и он же заменяет `FOR UPDATE`: уникальность в БД —
       * более сильный арбитр гонки, чем блокировка строки, и не держит транзакцию
       * дольше нужного.
       *
       * КЛЮЧ — НЕ ПРОСТО siteListingId. Один и тот же объект может пройти цикл
       * «удалили → восстановили в CRM → снова удалили с сайта» — это НЕ повтор
       * доставки, а две разные, законные команды на удаление. `existing.updatedAt`
       * (Prisma `@updatedAt`, обновляется при восстановлении) делает ключ разным в
       * каждом таком цикле, а у двух конкурентных доставок ОДНОЙ и той же команды —
       * одинаковым, потому что обе читают ещё не восстановленную строку.
       */
      const deliveryKey = `${existing.id}:${existing.updatedAt.getTime()}`;
      if (await isDuplicateDelivery("SITE_LISTING_DELETED", deliveryKey)) {
        return res.json({ ok: true, deleted: true, duplicate: true });
      }
      try {
        // В одной транзакции, как и создание/обновление ниже: порознь объект уходил
        // в Корзину без уведомления в «Изменениях на сайте», и о самом факте удаления
        // с сайта директор просто не узнавал.
        // Объект со сделкой в Корзину не уходит ни одним путём (аудит 23.09.2026,
        // №47): только снимается с сайта, а решение ложится директору в
        // «Изменения на сайте» тем же уведомлением.
        if ((await prisma.deal.count({ where: { propertyId: existing.id } })) > 0) {
          // Снятие с сайта меняет updatedAt, и ключ повтора выше станет другим —
          // поэтому второе уведомление не заводим, пока первое не разобрано.
          const pending = await prisma.siteEditNotification.findFirst({
            where: { propertyId: existing.id, action: "DELETED", resolution: null },
            select: { id: true },
          });
          await prisma.$transaction(async (tx) => {
            await tx.property.update({ where: { id: existing.id }, data: { publishedOnSite: false } });
            if (!pending) await tx.siteEditNotification.create({ data: { propertyId: existing.id, action: "DELETED" } });
          });
          void markProcessedMessageComplete("SITE_LISTING_DELETED", deliveryKey);
          return res.json({ ok: true, deleted: false, reason: "has-deals" });
        }
        await prisma.$transaction(async (tx) => {
          await tx.property.update({
            where: { id: existing.id },
            data: { deletedAt: new Date(), publishedOnSite: false },
          });
          await tx.siteEditNotification.create({ data: { propertyId: existing.id, action: "DELETED" } });
          // Заявка агента на удаление гасится и здесь — тот же класс бага, что чинил
          // trashProperty (07.09.2026): без этого удаление объекта САЙТОМ оставляло
          // заявку в Архиве висеть на объекте, которого уже нет. byAgentId: null —
          // решение принял внешний источник, не агент CRM (decidedById допускает null).
          // В ТОЙ ЖЕ транзакции, что и deletedAt (CHANNEL-NEW-16): после коммита сбой на
          // этом шаге оставлял объект в Корзине с открытой заявкой, а повторная доставка
          // видела deletedAt и ничего не делала. Сбой теперь откатывает всё, и сайт
          // повторит доставку целиком.
          await closePendingPropertyDeleteRequests([existing.id], null, "Объект удалён через сайт", tx);
          await revokePropertyShareLinks([existing.id], tx);
        });
        // Остальные спутники (очередь монтажа, контейнеры Instagram, показы) ходят в
        // сторонние сервисы и в транзакцию не входят; их добивает повторная доставка
        // (ветка `else if (existing)` ниже), поэтому порядок «коммит, потом спутники» безопасен.
        await closeTrashedPropertyWorkSatellites([existing.id]);
      } catch (err) {
        void releaseProcessedMessage("SITE_LISTING_DELETED", deliveryKey);
        throw err;
      }
      void markProcessedMessageComplete("SITE_LISTING_DELETED", deliveryKey);
    } else if (existing) {
      // Объект уже в Корзине: повторная доставка (сайт повторяет, если не получил 200, или
      // процесс упал после коммита до гашения спутников) гасит спутников заново, а не
      // отвечает «готово» вхолостую (CHANNEL-NEW-16). Все три шага идемпотентны: трогают
      // только открытые заявки, живые ссылки, незавершённую работу и будущие показы.
      await closePendingPropertyDeleteRequests([existing.id], null, "Объект удалён через сайт");
      await revokePropertyShareLinks([existing.id]);
      await closeTrashedPropertyWorkSatellites([existing.id]);
    }
    return res.json({ ok: true, deleted: Boolean(existing) });
  }

  /**
   * ОБЪЕКТ В КОРЗИНЕ ПРАВКУ С САЙТА НЕ ПРИНИМАЕТ (ночная проверка 24.09.2026,
   * №127). `deletedAt` мог поставить кто-то в CRM напрямую (не через этот же
   * вебхук) — сайт про это не знает и продолжает слать сюда обычные правки
   * формы. Раньше любая из них (даже опечатка в описании) молча возвращала
   * объект в базе к «живому» виду данных, хотя карточка скрыта и помечена
   * удалённой. Вернуть объект из Корзины — решение директора («Отклонить»
   * прежнее удаление в «Изменениях на сайте»), а не случайная правка формы.
   */
  if (existing?.deletedAt) {
    return res.json({ ok: true, propertyId: existing.id, created: false, trashed: true });
  }

  if (!d.title || !d.location || d.price == null || d.area == null) {
    return res.status(400).json({ error: "Недостаточно данных для создания объекта" });
  }

  const districts = await prisma.district.findMany({ select: { id: true, name: true } });
  if (districts.length === 0) return res.status(503).json({ error: "В CRM нет районов" });
  const { id: districtId, matched } = resolveDistrict(d.location, districts);
  const address = (d.mapAddress || d.location) + (matched ? "" : " (проверьте район)");
  const floorNum = d.floor ? parseInt(d.floor, 10) : null;

  const data = {
    title: d.title,
    type: (d.category ?? "APARTMENT") as "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND",
    rooms: d.rooms ?? null,
    areaSqm: d.area,
    floor: Number.isFinite(floorNum) ? floorNum : null,
    totalFloors: d.totalFloors ?? null,
    price: d.price,
    currency: "TJS" as const,
    districtId,
    address,
    condition: mapCondition(d.repair, d.type),
    description: d.description ?? null,
    lat: d.lat ?? null,
    lng: d.lng ?? null,
    // Координаты с сайта — такой же ручной ввод, как пин на карте в CRM: отметку
    // автогеокодера не ставим, иначе джоб перегеокодирования адреса их затрёт.
    ...(d.lat != null && d.lng != null ? { geocodedAt: null } : {}),
    siteListingId: d.siteListingId,
  };

  /**
   * При ОБНОВЛЕНИИ часть полей сознательно не трогаем — их в CRM могли поправить руками,
   * а вебхук прилетает на любую правку на сайте (хоть на опечатку в описании):
   *  - districtId: перезаписываем только при уверенном совпадении названия. Иначе
   *    resolveDistrict возвращает districts[0] — заведомо чужой район, и исправленный
   *    админом район откатывался к первому в списке.
   *  - lat/lng: сайт их часто не присылает. Повторно геокодируется только смена
   *    адреса через PATCH, поэтому карта навсегда падала на центр района.
   *  - currency: на сайте цена всегда в сомони, но в CRM объект мог быть переведён
   *    в доллары — переводим по курсу тем же приёмом, что и «Принять» правку сайта
   *    для объектов CRM (buildPropertyUpdateFromSiteChanges в siteNotifications.ts,
   *    решение аудита 24.09.2026 по #848), вместо жёсткого "TJS" или сырых сомони
   *    в поле price доллárового объекта.
   *  - rooms/floor/totalFloors/description/category(type)/repair(condition): сайт
   *    шлёт форму целиком, но поле в ней необязательно — раньше отсутствующее поле
   *    писалось как `null`/значение по умолчанию и стирало то, что поправили в CRM
   *    руками (ночная проверка 24.09.2026, №127). Пишем только то, что реально
   *    прислано в ЭТОМ вебхуке (`!== undefined`).
   */
  const priceValue = existing?.currency === "USD" ? roundMoney(fromTjs(d.price, "USD", await loadMoneyContext())) : d.price;
  const updateData: Prisma.PropertyUncheckedUpdateInput = {
    title: d.title,
    areaSqm: d.area,
    address,
    price: priceValue,
    ...(matched ? { districtId } : {}),
    ...(d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng, geocodedAt: null } : {}),
    ...(d.rooms !== undefined ? { rooms: d.rooms } : {}),
    ...(d.floor !== undefined ? { floor: Number.isFinite(floorNum) ? floorNum : null } : {}),
    ...(d.totalFloors !== undefined ? { totalFloors: d.totalFloors } : {}),
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.category !== undefined ? { type: d.category } : {}),
    ...(d.repair !== undefined || d.type !== undefined ? { condition: mapCondition(d.repair, d.type) } : {}),
  };

  const photos = (d.imageUrls ?? []).map((url, i) => ({
    url,
    thumbUrl: url.replace("/uploads/", "/uploads/thumbs/"),
    order: i,
  }));

  /**
   * Сверяем по `url`, а не переписываем все фото объекта начисто (ночная проверка
   * 24.09.2026, №127): фото, загруженные или улучшенные ПРЯМО В CRM (`/uploads/...`),
   * своей пары на сайте не имеют и никогда не придут назад в `imageUrls` — раньше
   * `deleteMany` без разбора стирал их из базы при любой следующей правке
   * объявления на сайте (хоть на опечатку в описании).
   */
  async function writePhotos(tx: TxClient, propertyId: string) {
    // Нет поля ИЛИ пустой массив — фото объекта не трогаем (решение владельца
    // 04.10.2026, RISK-04): пустой список не считаем командой «удалить всё», стереть
    // фото можно только в самой CRM, а не случайной доставкой с сайта.
    if (!d.imageUrls?.length) return;
    const current = await tx.propertyPhoto.findMany({ where: { propertyId } });
    const currentByUrl = new Map(current.map((p) => [p.url, p]));
    const incomingUrls = new Set(photos.map((p) => p.url));

    const toDelete = current.filter((p) => !incomingUrls.has(p.url) && !p.url.startsWith("/uploads/"));
    if (toDelete.length) {
      await tx.propertyPhoto.deleteMany({ where: { id: { in: toDelete.map((p) => p.id) } } });
    }
    const preserved = current.filter((p) => !incomingUrls.has(p.url) && p.url.startsWith("/uploads/"));

    for (const [i, ph] of photos.entries()) {
      const existingPhoto = currentByUrl.get(ph.url);
      if (existingPhoto) {
        if (existingPhoto.order !== i) await tx.propertyPhoto.update({ where: { id: existingPhoto.id }, data: { order: i } });
      } else {
        await tx.propertyPhoto.create({ data: { ...ph, propertyId } });
      }
    }
    // Сохранённые фото CRM донумеровываем следом за фото с сайта — порядок,
    // присланный сайтом, остаётся главным.
    for (const [i, p] of preserved.entries()) {
      await tx.propertyPhoto.update({ where: { id: p.id }, data: { order: photos.length + i } });
    }
  }

  // Уведомление о правке с сайта (ночная проверка 24.09.2026, №127): раньше
  // обновление уже заведённого на сайте объекта проходило молча — «Изменения
  // на сайте» показывали только создание и удаление таких объектов, ни одной
  // правки. `d` без служебных полей — тот же смысл, что `changes` у
  // /site-listing-changed, просто сайт тут шлёт не диф, а форму целиком.
  const { siteListingId: _notifSiteListingId, action: _notifAction, ...notificationChanges } = d;

  let property;
  let created = !existing;
  try {
    property = await prisma.$transaction(async (tx) => {
      const p = existing
        ? // Обновление уже заведённого объекта: данные подтягиваем, статус публикации
          // НЕ трогаем (им управляет модерация в CRM, а не сайт). listingAcceptedAt тоже
          // не трогаем: это дата приёма объекта в работу, и любая правка на сайте
          // (даже опечатка в описании) переставляла её на сегодня, ломая отчётность.
          await tx.property.update({ where: { id: existing.id }, data: updateData })
        : // Новый объект с сайта попадает НА МОДЕРАЦИЮ: пока скрыт (publishedOnSite=false),
          // и заводится уведомление во вкладку «Изменения на сайте» — директор решает,
          // публиковать или нет. До одобрения объект на сайте не виден.
          await tx.property.create({ data: { ...data, publishedOnSite: false, listingAcceptedAt: new Date() } });
      if (!existing) {
        await tx.siteEditNotification.create({ data: { propertyId: p.id, action: "CREATED" } });
      } else {
        await tx.siteEditNotification.create({
          data: { propertyId: p.id, action: "UPDATED", changes: notificationChanges },
        });
      }
      await writePhotos(tx, p.id);
      return p;
    });
  } catch (err) {
    // Гонка двух одновременных доставок одного и того же вебхука (та же причина
    // повтора, что у /website-lead — сайт не дождался ответа за таймаут именно
    // потому, что первая доставка ещё выполняется): обе видят existing=null выше
    // и обе пытаются create — вторая раньше падала голым 500 вместо идемпотентного
    // ответа, хотя объект не дублировался (siteListingId @unique).
    if (existing || !isSiteListingConflict(err)) throw err;
    const raced = await prisma.property.findUnique({ where: { siteListingId: d.siteListingId } });
    if (!raced) throw err;
    created = false;
    property = await prisma.$transaction(async (tx) => {
      const p = await tx.property.update({ where: { id: raced.id }, data: updateData });
      await writePhotos(tx, p.id);
      return p;
    });
  }

  res.status(created ? 201 : 200).json({ ok: true, propertyId: property.id, created });
});

/**
 * Подпись Meta — ОТДЕЛЬНЫМ middleware и строго ДО лимитера (26.08.2026).
 *
 * Ключ лимитера строится из sender.id — невалидированного поля тела запроса.
 * Пока подпись проверялась внутри обработчика, НЕподписанные запросы всё равно
 * инкрементировали счётчик выбранного отправителя: зная чей-то PSID/chat_id
 * (свой же PSID из переписки со страницей), можно было без всякой подписи
 * держать ключ жертвы в 429 — настоящие доставки Meta для этого клиента
 * отбрасывались, диалог «залипал». Теперь чужие запросы умирают на 403 до того,
 * как лимитер их посчитает.
 */
async function requireMetaSignature(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
): Promise<void> {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!(await verifyMetaSignature(raw, req.header("x-hub-signature-256")))) {
    res.status(403).json({ error: "Неверная подпись" });
    return;
  }
  registerAuthenticatedMetaCustomerRequest(req);
  next();
}

/** Секрет Telegram — тем же правилом: до лимитера, ключуемого по chat_id из тела. */
function requireTelegramSecret(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
): void {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !secretsMatch(req.header("x-telegram-bot-api-secret-token") ?? "", secret)) {
    res.status(403).json({ error: "Неверный секрет" });
    return;
  }
  next();
}

// Отправитель лежит в разных местах: у Instagram и Messenger — в
// entry[].messaging[].sender.id, у WhatsApp — в entry[].changes[].value.messages[].from,
// у комментариев Instagram — в entry[].changes[].value.from.id. Общая функция —
// её делят keyGenerator (ключ лимита) и handler ниже (кого именно душим в журнале),
// раньше вычисление жило только внутри keyGenerator и для журнала было недоступно.
//
// СЧИТАЕМ ТОЛЬКО ТО, ЧТО НАПИСАЛ КЛИЕНТ (аудит 23.09.2026, круг 3, №70). Раньше
// брался отправитель ПЕРВОЙ записи тела, какой бы она ни была. У эха нашего же
// ответа (`message.is_echo`) отправитель — НАШ аккаунт, поэтому все ответы бота и
// агентов всем клиентам сразу копились в одном ведре `meta:<наш id>`: в разгар
// рекламы больше 30 наших ответов в минуту — и Meta получала 429 на эхо, а
// вместе с ним на всё тело, где за эхом лежали сообщения живых клиентов. Эхо при
// этом не пустое: по нему бот замолкает, когда сотрудник ответил из приложения
// (handleOutgoingEcho), — отбитое эхо значит бот и человек отвечают наперебой.
// Статусы WhatsApp (`value.statuses` без `value.messages`) отправителя не имеют
// вовсе и все вместе ложились в одно ведро по адресу Meta. Теперь ключ — первый
// КЛИЕНТ в теле (сообщение без is_echo, нажатая кнопка, сообщение WhatsApp,
// комментарий), а тело без единой реплики клиента лимитом не считается совсем:
// подпись Meta уже сверена, а платной работы (ход бота) по нему не будет.
type MetaLimiterBody = {
  entry?: {
    messaging?: { sender?: { id?: unknown }; message?: { is_echo?: unknown }; postback?: unknown }[];
    changes?: { value?: { messages?: { from?: unknown }[]; from?: { id?: unknown } } }[];
  }[];
};

export function metaLimiterSender(body: unknown): string | null {
  const entries = (body as MetaLimiterBody | null)?.entry;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    for (const m of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const fromClient = (m?.message && m.message.is_echo !== true) || m?.postback;
      const id = m?.sender?.id;
      if (fromClient && typeof id === "string" && id) return id;
    }
    for (const c of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = c?.value;
      const id = (Array.isArray(value?.messages) ? value.messages[0]?.from : undefined) ?? value?.from?.id;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/** Лимит вебхука Meta. Ключуем по отправителю, а не по IP: весь трафик идёт с
 *  адресов Meta, и общий лимит по IP душил бы всех клиентов разом. 30 сообщений
 *  в минуту от одного человека — с запасом для живого диалога, стена от цикла. */
const metaChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Тело без реплики клиента (эхо наших ответов, статусы доставки, «прочитано»)
  // лимитом не считается — см. metaLimiterSender выше.
  skip: (req) => metaLimiterSender(req.body) === null,
  keyGenerator: (req) => {
    // Комментарии Instagram лежат третьим путём — entry[].changes[].value.from.id.
    // Без него все комментарии считались бы одним отправителем «ip:», и оживший
    // пост выбирал бы общий лимит на всех за полминуты.
    const sender = metaLimiterSender(req.body);
    return sender ? `meta:${sender}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "Слишком много сообщений, подождите немного" },
  /**
   * ЛИМИТ БЕЗ СЛЕДА В ЖУРНАЛЕ — ЖИВОЙ КЛИЕНТ ПОД ВСПЛЕСКОМ РЕКЛАМЫ НЕВИДИМ
   * (пробел найден предпусковым аудитом перед стартом рекламы, 16.09.2026).
   *
   * До этой правки лимитер молча отвечал 429 и ничего не записывал: ложное
   * срабатывание на живом клиенте (например, он шлёт фото номера отдельными
   * сообщениями подряд в разгар рекламного всплеска) не попадало ни в журнал
   * ошибок, ни в утреннюю сводку — директор о потерянном клиенте не узнавал
   * вообще. handler заменяет статическое message: express-rate-limit сам
   * подставляет заголовки и код 429, здесь только логируем и отдаём тот же
   * ответ, что раньше уходил через message. logSystemError не должен уронить
   * ответ клиенту при сбое журнала — поэтому await, но в try/catch.
   */
  handler: async (req, res, _next, options) => {
    const sender = metaLimiterSender(req.body);
    const channel = sender ? "meta" : "meta:unknown-sender";
    try {
      await logSystemError(
        "meta",
        `Лимит сообщений вебхука Meta: отправитель ${sender ?? "не определён (ключ по IP)"} ` +
          `(${channel}) превысил 30 сообщений/мин — сообщение отклонено (429). Возможен всплеск ` +
          `рекламного трафика или ложное срабатывание на живом клиенте.`
      );
    } catch (err) {
      console.error("[webhooks] metaChatLimiter logSystemError", err instanceof Error ? err.message : err);
    }
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Вебхук Meta — Instagram Direct напрямую, без сторонней бот-платформы.
 *
 * GET — рукопожатие при подключении в панели Meta: она дёргает адрес и ждёт
 * обратно ровно hub.challenge. Пока этот ответ не сойдётся, кнопка «Подтвердить
 * и сохранить» в панели не сработает — поэтому эндпоинт должен жить на проде
 * ДО настройки в интерфейсе Meta.
 */
webhooksRouter.get("/meta", async (req, res) => {
  const challenge = await verifyMetaHandshake(req.query as Record<string, unknown>);
  if (!challenge) return res.status(403).send("Forbidden");
  // Ровно текст, без JSON-обёртки: Meta сравнивает тело побайтово.
  res.type("text/plain").send(challenge);
});

/**
 * POST — входящие сообщения.
 *
 * Meta считает доставку успешной по коду 200 и повторяет запрос при любом
 * другом. Поэтому после того, как подпись сошлась, отвечаем 200 всегда: сбой
 * нашей обработки не должен превращаться в бесконечные повторы от Meta. Сама
 * ошибка при этом попадает в журнал, а не теряется.
 */
/**
 * Имя автора для диалога Instagram: вебхук приносит только идентификатор, а в
 * карточке из-за этого стояло «Без имени». Спрашиваем @ник у Graph API.
 *
 * Только для Instagram и только когда имени ещё нет: запрос в БД дешевле
 * внешнего вызова, а имя у диалога меняться не должно. Отказ Graph API не
 * мешает ответить клиенту — вернётся undefined, и диалог заведётся как прежде.
 */
/**
 * Ответ смайликом вместо полноценного текста — общий приём для «пустой реакции»
 * клиента (🔥 на сторис) и для повторного «спасибо» после уже состоявшегося
 * прощания (см. reactOnly в MessengerTurnResult, conversation.ts). В WhatsApp —
 * настоящая реакция на сообщение клиента; в Instagram/Messenger такого эндпоинта
 * у Meta нет вовсе — там отдельным сообщением-смайликом, как и раньше.
 */
async function sendReactionOrEmoji(
  channel: MetaChannel,
  senderId: string,
  messageId: string | undefined,
  token: string | undefined,
  customerTransport?: import("../lib/customerConversationScope.js").CustomerTransportReference
): Promise<void> {
  if (channel === "WHATSAPP" && messageId) {
    await sendMetaReaction(senderId, messageId, reactionHeart(messageId), token, customerTransport);
  } else {
    await stampOutgoingMid(
      channel,
      senderId,
      await sendMetaMessage(channel, senderId, emojiThanksReply(messageId ?? senderId), token, { transport: customerTransport }), customerTransport
    );
  }
}

async function resolveInstagramName(channel: MetaChannel, senderId: string, tokenOverride?: string, accountId?: string | null,
  transport?: import("../lib/customerConversationScope.js").CustomerTransportReference): Promise<string | undefined> {
  if (channel !== "INSTAGRAM" && channel !== "FACEBOOK") return undefined;
  const scoped = await findScopedBotConversation({ channel, subscriberId: senderId, accountId, transport });
  const known = scoped ? await prisma.botConversation.findUnique({ where: { id: scoped.id }, select: { name: true } }) : null;
  if (known?.name) return undefined;
  // Messenger: имени в вебхуке нет, PSID резолвится маркером Страницы. Без этой
  // ветки диалоги Facebook жили «Без имени», а isOwnAccountSender по имени для
  // канала не работал (26.08.2026).
  if (channel === "FACEBOOK") return fetchMessengerName(senderId, tokenOverride);
  /**
   * ОТКАЗ ПРОФИЛЯ НЕ ДОЛЖЕН РОНЯТЬ ОБРАБОТКУ (16.08.2026, живой прогон).
   *
   * Graph отвечает «The requested user cannot be found» (IGApiException 2534014)
   * на вполне обычных людей: профиль закрыт, аккаунт новый, маркер не той
   * страницы. Раньше это было почти безобидно — имя резолвилось поздно, внутри
   * ветки, которая падение переживала. Теперь резолв стоит ПЕРВЫМ (по нему мы
   * узнаём собственные аккаунты), и брошенная отсюда ошибка убивала весь ход:
   * человек нажал кнопку воронки и не получил ничего.
   *
   * Имя — украшение переписки, а не условие ответа. Не узнали — работаем без него.
   */
  try {
    const profile = await fetchInstagramProfile(senderId, tokenOverride);
    // @ник узнаваем и уникален, поэтому он важнее имени профиля: по «Алишер» в
    // Instagram человека не найти, по нику — сразу.
    return profile.username ? `@${profile.username}` : profile.name;
  } catch {
    return undefined;
  }
}

/**
 * Что мы скачиваем с CDN мессенджера.
 *
 * Видео и документы добавлены 02.08.2026 вместе с разбором через Gemini
 * (ai/geminiMedia.ts). До этого они сюда не попадали вовсе, и бот отвечал на рум-тур
 * продавца просьбой пересказать словами то, что человек снял именно чтобы не
 * пересказывать. У WhatsApp тип приходит как "video"/"document", у Instagram и
 * Messenger документ называется "file" — нужны все три написания.
 *
 * Стикер по-прежнему не качаем: это картинка без содержания, и отвечать на неё
 * нужно коротким «по-доброму», а не разбором (см. ATTACHMENT_HINTS).
 *
 * "ig_reel" ДОБАВЛЕН 19.08.2026 — БЫЛ САМЫЙ ДОРОГОЙ ПРОПУСК ИЗ ВСЕХ.
 *
 * Живой случай владельца: клиент дважды (16.08 и 19.08) прислал видео своей
 * квартиры, и оба раза бот ответил заготовкой «видео у меня не открылось» —
 * хотя видео вообще не пытались скачать. Meta размечает ЛЮБОЕ видео, отправленное
 * в директ Instagram через камеру reels, тем же типом "ig_reel", что и пересланную
 * ПУБЛИКАЦИЮ (см. isSharedPost/sharedMediaHint в messengers/sharedMedia.ts) — тип
 * один, а смысл разный: то ссылка на чужой/наш существующий пост (страница
 * instagram.com/reel/CODE, качать нечего), то прямой CDN-адрес (scontent-*.
 * cdninstagram.com/...mp4) — ролик, который клиент снял сам и прислал как есть.
 * Различить их по типу нельзя, только по результату скачивания. Раньше "ig_reel"
 * в этот список не входил вовсе, и код даже не пробовал: fetchOne (attachments.ts)
 * ни разу не вызывался для CDN-варианта, Gemini File API — тоже, а бот всегда уходил
 * в ветку "isShare" (sharedMedia.ts) с готовым текстом про непрочитанное видео.
 * Теперь URL пробуем скачать всегда: страница вернёт text/html и detect() честно
 * пометит её unsupported (никакого нового риска — тот же путь, что уже проходят
 * пересланные ссылки), а настоящий CDN-файл дойдёт до Gemini и получит разбор.
 */
const DOWNLOADABLE_ATTACHMENTS = new Set(["image", "audio", "voice", "video", "document", "file", "ig_reel"]);

/**
 * Эхо нашего исходящего: свои реплики пропускаем молча, ручной ответ сотрудника
 * из приложения — записываем в переписку и останавливаем бота.
 *
 * ПОЧЕМУ ПАУЗА, А НЕ ПРОСТО ЗАПИСЬ. Пока сотрудник разговаривает с клиентом
 * сам, бот обязан молчать: иначе он отвечает поверх живого человека и они
 * противоречат друг другу.
 *
 * ПОЧЕМУ КОРОТКАЯ, А НЕ БЕССРОЧНАЯ (уточнение владельца 18.08.2026). У ответа
 * через CRM (conversationDelivery.ts) бессрочная пауза ставится, только когда
 * отвечает закреплённый за клиентом агент (Client.assignedAgentId) — здесь
 * проверить это нечем: Meta в эхо-сообщении называет только аккаунт страницы,
 * а не сотрудника, который держал телефон (см. MessageSender.kind:"manual" в
 * @royal-home/shared). Раз сверить отправителя с закреплённым агентом
 * невозможно, бессрочной паузы здесь нет. Но и 10 минут (как у разовой помощи
 * из CRM) мало: бот возвращался в разговор, который директор ещё вёл с телефона
 * (жалоба владельца 28.09.2026) — поэтому 12 часов, OPERATOR_ECHO_PAUSE_MS.
 */
export async function handleOutgoingEcho(msg: {
  channel: MessengerChannel;
  senderId: string;
  text: string;
  attachmentType?: string;
  messageId?: string;
  accountExternalId?: string;
}): Promise<void> {
  /**
   * СНАЧАЛА — память об отправке, и только потом переписка.
   *
   * Между «отправили» и «записали mid в переписку» есть щель: отправители шлют
   * пачкой (воронка — текст, затем PDF), а историю пишут одним махом в конце.
   * Эхо первого сообщения приходит в эту щель, в переписке его mid ещё нет — и
   * раньше CRM принимала собственное сообщение за ручной ответ сотрудника:
   * дописывала вторую копию и глушила бота на 10 минут (18.08.2026, @farruhruz_).
   * Отметка ставится в момент отправки, поэтому здесь она уже есть всегда.
   */
  if (await wasSentByUs(msg.messageId)) { traceEchoReason("known_mid"); return; }

  const scoped = await findScopedBotConversation({ channel: msg.channel, subscriberId: msg.senderId, accountExternalId: msg.accountExternalId });
  const conv = scoped ? await prisma.botConversation.findUnique({ where: { id: scoped.id }, select: { id: true, messages: true } }) : null;
  // Диалога нет — писать некуда и глушить нечего (сотрудник начал переписку сам,
  // клиент нам ещё не писал). Заводить диалог с одного нашего сообщения не нужно:
  // он появится с первым ответом клиента, обычным путём.
  if (!conv) { traceEchoReason("unknown"); return; }
  if (scoped && await isOwnCustomerOutboxEcho({ conversationId: conv.id, accountId: scoped.accountId,
    channel: msg.channel, peer: msg.senderId, text: msg.text, messageId: msg.messageId })) {
    traceEchoReason("in_flight"); return;
  }

  const history = (Array.isArray(conv.messages) ? conv.messages : []) as (EchoHistoryEntry & {
    // Показ объекта (messengers/propertyShowcase.ts) кладёт mid КАЖДОГО отправленного
    // фото при его вложении, а не в mid/mid2 реплики — фотографий бывает больше двух,
    // и одна пара полей на всю пачку не годится (см. showcaseMessages в conversation.ts).
    attachments?: { mid?: string }[];
  })[];
  // Наше собственное отправленное сообщение вернулось эхом — молчим. Без этой
  // проверки бот ставил бы себе паузу после каждой своей реплики.
  if (
    msg.messageId &&
    history.some(
      (m) => m.mid === msg.messageId || m.mid2 === msg.messageId || m.attachments?.some((a) => a.mid === msg.messageId)
    )
  )
    { traceEchoReason("history_mid"); return; }

  // Эхо пришло раньше, чем Graph API ответил на отправку: ни отметки, ни mid в
  // переписке ещё нет, но реплика бота уже записана. Это наше — не пауза
  // (живой случай 13.10.2026, см. messengers/inFlightEcho.ts). mid к реплике
  // допишет stampOutgoingMid, когда отправка вернётся.
  if (isOwnInFlightEcho(history, msg.text, Date.now())) {
    traceEchoReason("in_flight");
    console.log(`[вебхук] ${msg.channel}: эхо ответа бота обогнало отправку — не ручной ответ (диалог ${conv.id})`);
    return;
  }

  /**
   * ШАБЛОННАЯ КАРТОЧКА — ВСЕГДА НАША, ЧЕЛОВЕК ЕЁ ОТПРАВИТЬ НЕ МОЖЕТ (22.08.2026).
   *
   * Карточку с кнопкой шлёт только CRM (воронка лид-магнита, sendButtonCard в
   * messengers/meta.ts) — в приложении Instagram у сотрудника такой кнопки нет
   * вовсе. Но `wasSentByUs` спасает лишь тогда, когда Meta вернула `message_id`:
   * при отказе `sendButtonCard` отдаёт null, mid не запоминается, а эхо приходит
   * всё равно — и дальше код принимал СВОЮ ЖЕ карточку за ручной ответ сотрудника:
   * дописывал в переписку «[вложение: template]» и глушил бота на 10 минут.
   *
   * Именно это видно в разборе живых переписок 22.08.2026: диалоги, где последняя
   * строка — «[вложение: template]», а дальше тишина, хотя человек продолжал
   * писать («Гирифтани PDF», «Где мой дастур?»). Пауза, поставленная нашей же
   * карточкой, отвечала за молчание вместо сотрудника, которого там не было.
   *
   * Поэтому шаблон без текста не считаем ручным ответом: ни записи, ни паузы.
   * Ошибиться в эту сторону безопасно — настоящий сотрудник шлёт текст, фото или
   * голосовое, и любой из этих случаев паузу по-прежнему ставит.
   */
  if (!msg.text && msg.attachmentType === "template") {
    traceEchoReason("template");
    console.log(`[вебхук] ${msg.channel}: эхо нашей карточки с кнопкой — не ручной ответ (диалог ${conv.id})`);
    return;
  }

  // Пауза — РАНЬШЕ записи в переписку (26.08.2026). Это два независимых запроса, и
  // при прежнем порядке сбой второго оставлял реплику сотрудника в истории, а бота —
  // БЕЗ паузы: он продолжал отвечать поверх живого человека (ровно баг 17.08, ради
  // которого ветка написана). Хуже: ошибка снимала замок дубля, и повторная доставка
  // эха дописывала реплику в переписку второй раз. В обратном порядке сбой append
  // безопасен: пауза уже стоит, повтор доставки поставит её снова и допишет реплику.
  // Короткая пауза не укорачивает действующую длинную (23.09.2026): свой агент
  // ответил из CRM — бот молчит годами, и сотрудник, дописавший с телефона, не
  // должен возвращать бота в разговор через 10 минут (applyDeliveryPause).
  await applyDeliveryPause({ kind: "bot", id: conv.id }, new Date(Date.now() + OPERATOR_ECHO_PAUSE_MS), true);
  traceEchoReason("manual");
  const written = msg.text || (msg.attachmentType ? `[вложение: ${msg.attachmentType}]` : "");
  if (written) {
    await appendConversationMessages(conv.id, [{ role: "assistant", content: written, by: { kind: "manual" } }]);
  }
  console.log(`[вебхук] ${msg.channel}: ответ вручную из мессенджера — бот на паузе (диалог ${conv.id})`);
}

/** Тот же принцип, что у metaChatLimiter — ключуем по chat_id, не по IP: весь
 *  трафик идёт с адресов Telegram, общий лимит по IP душил бы всех клиентов разом. */
const telegramChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // callback_query несёт чат в message ВНУТРИ callback_query — без этой ветки
    // все нажатия кнопок всех клиентов делили один лимит по IP Telegram (26.08.2026).
    const body = req.body as {
      message?: { chat?: { id?: unknown } };
      callback_query?: { message?: { chat?: { id?: unknown } } };
    };
    const chatId = body?.message?.chat?.id ?? body?.callback_query?.message?.chat?.id;
    return typeof chatId === "number" || typeof chatId === "string"
      ? `tg:${chatId}`
      : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "Слишком много сообщений, подождите немного" },
});

/**
 * Вебхук Telegram (19.08.2026) — замена long polling (telegram/poller.ts).
 * Секрет — не подпись тела (Telegram таким не подписывает), а заголовок
 * X-Telegram-Bot-Api-Secret-Token, который Telegram возвращает НЕИЗМЕННЫМ
 * с каждым запросом ровно тем же значением, что было передано в setWebhook.
 * Без совпадения — 403 до всякого разбора тела, как и у Meta.
 *
 * Дедуп по update_id переиспользуем из поллера (lib/webhookDedupe.ts):
 * тот же update может прийти повторно, если Telegram не получил 200 вовремя.
 */
webhooksRouter.post("/telegram", requireTelegramSecret, telegramChatLimiter, async (req, res) => {
  // Секрет уже сверен middleware'ом requireTelegramSecret — ДО лимитера, чтобы
  // неподписанные запросы не инкрементировали счётчик чужого chat_id.
  const update = req.body as TelegramUpdate;
  // Отвечаем сразу: Telegram считает доставку успешной по коду 200 и повторяет
  // запрос, если не дождался ответа — тот же принцип, что у /meta ниже.
  res.json({ ok: true });

  if (typeof update?.update_id !== "number") return;

  // РЕГИСТРАЦИЯ В РЕЕСТРЕ ОСТАНОВКИ (21.09.2026, lib/shutdownState.ts).
  //
  // До этой правки вся обработка ниже запускалась как «повиснет само» ПОСЛЕ
  // res.json — тот самый класс потерь, что и у публикации живых событий
  // (см. докстринг shutdownState.ts), только опаснее: там теряется публикация
  // события, здесь — реплика самого клиента (объект №114 в ночь на 21.09 стал
  // поводом искать остальные места этого приёма). `drainBackgroundTasks` в
  // index.ts теперь ждёт эту работу в рамках грейса мягкой остановки наравне с
  // кронами; сам вебхук уже ответил Telegram, поэтому таймаут доставки не растёт.
  void trackBackgroundTask(
    (async () => {
      // Часть альбома дедупится в момент СКЛЕЙКИ (telegram/bot.ts, bufferAlbum), а не
      // здесь: отметка при приёме + рестарт в окне буфера теряли пачку фото навсегда.
      const albumPart = isAlbumPart(update);
      if (!albumPart && (await isDuplicateDelivery("TELEGRAM", String(update.update_id)))) {
        console.log(`[вебхук] telegram: апдейт ${update.update_id} уже обработан — пропускаем`);
        return;
      }
      try {
        // Повтор приёма (JOB-06): Telegram уже получил 200 и не пришлёт апдейт заново.
        await withTelegramUpdateRetry(() => handleTelegramUpdate(update));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[вебхук] telegram: ошибка обработки апдейта:", reason);
        void logSystemError("telegram", `Апдейт не обработан (вебхук): ${reason}`);
        // Замок дубля снимаем — как у Meta ниже. Иначе транзиентный сбой (база моргнула,
        // сеть до Telegram) съедает сообщение клиента НАВСЕГДА: повторная доставка того же
        // update отбрасывается как «уже обработан» — ровно то, от чего предостерегает
        // политика lib/webhookDedupe.ts («молча съеденное сообщение хуже второго ответа»).
        // У части альбома отметки ещё нет — снимать нечего.
        if (!albumPart) void releaseProcessedMessage("TELEGRAM", String(update.update_id));
      } finally {
        // Отметка завершения (21.09.2026) — см. комментарий у той же строки в /meta
        // ниже и докстринг lib/webhookDedupe.ts. У части альбома отметки нет вовсе —
        // updateMany просто ничего не найдёт.
        if (!albumPart) void markProcessedMessageComplete("TELEGRAM", String(update.update_id));
      }
    })().catch((err) => {
      // Ошибка вне внутреннего try (проверка повтора, чтение настроек) иначе
      // пропадала без следа: trackBackgroundTask гасит отказ, и сообщение
      // клиента терялось молча (аудит 23.09.2026, круг 3, №84).
      void logSystemError("telegram", `Вебхук Telegram: обработка оборвалась: ${describeError(err)}`);
    })
  );
});

webhooksRouter.post("/meta", requireMetaSignature, metaChatLimiter, async (req, res) => {
  // Подпись уже сверена middleware'ом requireMetaSignature — и именно ДО
  // лимитера: его ключ строится из sender.id в теле, и неподписанные запросы не
  // должны инкрементировать счётчик чужого клиента (см. комментарий у middleware).
  // Рубильник канала — после подписи, чтобы чужой запрос не мог по коду ответа
  // выяснить состояние наших настроек.
  if (!(await isMetaEnabled())) {
    return res.status(503).json({ error: "Канал Meta выключен в Настройках CRM" });
  }

  // Свой номер передаём в разбор: у приложения Meta рядом с боевым номером
  // всегда живёт тестовый из песочницы, и его вебхуки подписаны тем же
  // секретом — по подписи их не отличить.
  const waPhoneId = await getMetaWaPhoneId();
  const incoming = parseMetaIncoming(req.body, waPhoneId);
  // Short durable intake precedes the provider ACK when the scoped rollout
  // is enabled. No model/provider call occurs here. OFF follows legacy intake.
  const durableIngress = await persistVerifiedCustomerIngressBatch(req);
  if (durableIngress.status === "denied" || durableIngress.status === "unavailable") {
    return res.status(503).json({ error: "Входящее событие пока не сохранено" });
  }
  // Public inputs keep their actual publication/thread and immutable original
  // installation before ACK. A scoped intake failure must not escape into the
  // old post-ACK comment funnel on a provider redelivery.
  const publicIngress = await persistVerifiedMetaPublicCommentBatch(req);
  if (publicIngress.status === "held") {
    return res.status(503).json({ error: "Комментарий пока не сохранён" });
  }
  const propertyAdmissions = new Map<(typeof incoming)[number], CustomerPropertyAdmissionResult>();
  const propertyReferrals = new Map<(typeof incoming)[number], import("../messengers/metaPeerMemory.js").RememberedAdReferral>();
  // Отвечаем Meta сразу, не дожидаясь ИИ: обработка одного сообщения занимает
  // секунды, а Meta ждёт ответа несколько и иначе шлёт дубль.
  res.json({ ok: true });

  // РЕГИСТРАЦИЯ В РЕЕСТРЕ ОСТАНОВКИ (21.09.2026, lib/shutdownState.ts) — тот же
  // приём и та же причина, что у /telegram выше: всё, что ниже, выполняется
  // ПОСЛЕ ответа Meta и раньше не было видно никакому механизму остановки.
  // Комментарии, статусы доставки и сами входящие сообщения — вся эта работа
  // должна пережить мягкую остановку в рамках грейса, а не оборваться на
  // полуслове при рестарте контейнера.
  void trackBackgroundTask(
    (async () => {
      // Immutable admissions precede profile/media/ad enrichment. Scoped
      // pending payloads/jobs have already committed before the ACK above.
      {
        for (const message of incoming) {
          if (message.isEcho) continue;
          const originalRoute = inspectCustomerDmRouting(customerDmRoutingForIncoming(req, message));
          if (originalRoute && originalRoute.execution.lane !== "LEGACY") continue; // P11 owns CORE; HELD never falls through.
          // The first referral can precede any namespace. Remember only an
          // exactly configured target, without creating scope/native/admission.
          // Its evidence is bound later to the next genuine MID in this tuple.
          if (message.referralOnly) {
            if (customerPropertyContextEnabled() && message.fromAd && message.accountExternalId &&
                await verifyMetaCustomerReferralTarget(req as typeof req & { rawBody?: Buffer }, { channel: message.channel, peer: message.senderId,
                  accountExternalId: message.accountExternalId })) {
              rememberAdReferral(message.channel, message.senderId, { adId: message.adId, adRef: message.adRef,
                adPostId: message.adPostId, adTitle: message.adTitle }, Date.now(), message.accountExternalId);
            }
            propertyAdmissions.set(message, { status: "denied", reason: "missing_identity" });
            continue;
          }
          // Foundation identity/order exists independently of property rollout.
          // A new env-only namespace can be initialized by genuine verified IN,
          // never by an echo, staff frame, referral-only or guessed peer history.
          let transport: import("../lib/customerConversationScope.js").CustomerTransportReference | undefined;
          try {
            transport = await resolveCustomerEndpoint({ channel: message.channel, subscriberId: message.senderId,
              accountExternalId: message.accountExternalId });
          } catch (error) {
            if (error instanceof CustomerScopeDenied && error.reason === "scope_unknown") {
              const initialized = await initializeVerifiedCustomerEndpoint(req as typeof req & { rawBody?: Buffer }, {
                channel: message.channel, peer: message.senderId, accountExternalId: message.accountExternalId }, {
                kind: message.payload ? "postback" : "message", isEcho: message.isEcho,
                bareTemplateEcho: !message.text && message.attachmentType === "template", referralOnly: message.referralOnly,
                ownAccountSender: await isOwnAccountSender({ senderId: message.senderId, senderName: message.name }),
                knownOutgoingMid: message.messageId ? await wasSentByUs(message.messageId) : false,
                // No existing scoped native can contain an in-flight marker
                // before this first routing scope. Unknown historical natives
                // are not adopted by ensureScopedBotConversation below.
                inFlightBotEcho: false });
              transport = initialized ?? undefined;
            }
          }
          if (!transport) { propertyAdmissions.set(message, { status: "denied", reason: "account_mismatch" }); continue; }
          // A signed referral without MID cannot reserve a generation itself.
          // Bind it to the next stable incoming event in the SAME account/peer
          // scope; its provider identity is the actual next event, never a hash
          // pretending that the referral was a uniquely identified message.
          let evidenceMessage = message;
          const pendingReferral = customerPropertyContextEnabled() && message.accountExternalId ? peekAdReferral(message.channel, message.senderId, message.accountExternalId) : null;
          if (!message.fromAd && message.messageId && message.accountExternalId) {
            if (pendingReferral) evidenceMessage = { ...message, ...pendingReferral.ref, fromAd: true, propertyReferralOrigin: "remembered_referral" };
          }
          const admission = await admitCustomerPropertyInput({ channel: message.channel, peer: message.senderId,
            accountExternalId: message.accountExternalId, transport, eventKind: message.payload ? "postback" : "message",
            eventId: message.messageId, evidence: customerPropertyContextEnabled() ? customerPropertyEvidenceFromMeta(evidenceMessage) : [], deferFocusUntilClassification: true,
            customerRoutingWitness: customerDmRoutingForIncoming(req, message) ?? undefined });
          propertyAdmissions.set(message, admission);
          if (!message.referralOnly && admission.status === "admitted" && admission.fresh && pendingReferral && message.accountExternalId) {
            consumeAdReferral(message.channel, message.senderId, message.accountExternalId, pendingReferral);
            if (!message.fromAd) propertyReferrals.set(message, pendingReferral.ref);
          }
        }
      }
      // Комментарии под публикациями приходят тем же вебхуком, но отдельным полем
      // (changes[].field = "comments") и живут по своим правилам: отвечаем не сразу,
      // спам скрываем. Здесь только очередь, вся работа — в messengers/comments.ts.
      if (publicIngress.status !== "persisted") void ingestInstagramComments(req.body);

      // Статусы доставки/прочтения (18.08.2026) — WhatsApp присылает их тем же
      // вебхуком, что и входящие сообщения, отдельными записями `value.statuses`
      // без `value.messages`. Раньше это поле было типа unknown и терялось молча.
      // Кабинет WhatsApp (для одобренных текстов первого сообщения) узнаётся сам
      // из вебхука — владельцу не нужно искать его в панели Meta.
      void rememberBusinessAccountFromWebhook(req.body, waPhoneId);

      for (const s of parseMetaStatusUpdates(req.body)) {
        void withBotTurnTrace({ channel: "WHATSAPP", account: s.accountExternalId, source: "delivery_status", event: null }, async () => {
          if (["sent", "delivered", "read", "failed"].includes(s.status)) traceDeliveryStatus(s.mid, s.status);
        });
        void markMessageDeliveryStatus(s.recipientId, s.mid, s.status, s.accountExternalId);
        // Первое сообщение клиенту (одобренный текст): «не дошло» — пуш сотруднику с причиной.
        void noteFirstContactDelivery(s.mid, s.status, s.errorCode, s.error);
        /**
         * ОТКАЗ ДОСТАВКИ НЕ МОЛЧИТ (правка 22.09.2026).
         *
         * `failed` приходит асинхронно, уже после нашего 200: сама отправка
         * прошла, а сообщение до человека не дошло. Раньше это становилось
         * серой галочкой в интерфейсе и больше ничем — ни строки в журнале
         * ошибок, где владелец ищет причины. Между тем причины разные и чинятся
         * по-разному: закрытое окно 24 часов, номер вне WhatsApp, неодобренный
         * шаблон, лимит. `dedupKey` по причине, а не по сообщению: пачка
         * однотипных отказов должна читаться одной строкой, а не сотней.
         */
        if (s.status === "failed") {
          void logSystemError(
            "meta",
            `WhatsApp не доставил наш ответ на ${s.recipientId}` + (s.error ? `: ${s.error}` : " (причину Meta не назвала)"),
            { dedupKey: `wa-delivery-failed-${s.error ?? "unknown"}` }
          );
        }
      }

      // Отсев чужого номера больше не бесшумный. Ошибиться идентификатором в
      // Настройках слишком легко, а последствие катастрофическое и невидимое: все
      // входящие исчезают, Meta получает честные 200 и ошибок доставки не
      // показывает, искать причину не по чему. Пишем в журнал сразу оба номера —
      // из этой записи видно, чей идентификатор исправлять.
      if (waPhoneId) {
        const foreign = foreignMetaWaPhoneIds(req.body, waPhoneId);
        if (foreign.length > 0) {
          void logSystemError(
            "meta",
            `Сообщение WhatsApp отброшено: пришло на номер ${foreign.join(", ")}, а в Настройках указан ${waPhoneId}. ` +
              `Если отброшенный номер — ваш боевой, исправьте «ID номера телефона» в Настройках → Meta; ` +
              `если это тестовый номер песочницы Meta, всё верно и запись можно закрыть.`
          );
        }
      }

      // «Прочитано» и «печатает…» показываем только когда отвечает бот: если он
      // выключен, честнее ничего не изображать — сообщение прочитает живой агент,
      // и галочки появятся тогда, когда это правда.
      // Рубильники читаем один раз на весь вебхук, а не на каждое сообщение: в одном
      // теле Meta приносит пачку, а настройки за эти миллисекунды не меняются.
      const bot = await loadBotChannelToggles();

      /**
       * РАЗНЫЕ СОБЕСЕДНИКИ — ПАРАЛЛЕЛЬНО, ОДИН СОБЕСЕДНИК — ПО ПОРЯДКУ (23.09.2026,
       * аудит №26). Meta приносит в одном теле пачку сообщений от разных людей, а
       * ход бота ждёт окно склейки (до 25 с) и модель. Строго по очереди второй
       * клиент ждал, пока бот договорит с первым, третий — со вторым. Сообщения
       * одного человека (и эхо ответов ему) остаются строго по порядку.
       */
      await Promise.all(
        groupMetaBySender(incoming).map(async (group) => {
      for (const traceMessage of group) {
      await withBotTurnTrace({ channel: traceMessage.channel, peer: traceMessage.senderId, account: traceMessage.accountExternalId,
        event: traceMessage.messageId, source: "webhook", text: traceMessage.text,
        kind: traceMessage.isEcho ? "echo" : traceMessage.referralOnly ? "referral" : traceMessage.attachmentType ? "media" : "text",
        attachments: (traceMessage.attachmentType ? 1 : 0) + (traceMessage.extraAttachments?.length ?? 0),
        ingress: traceMessage.traceIngressShape, knownContacts: traceMessage.name ? [traceMessage.name] : [] }, async () => {
      // Keep the existing continue/finally semantics inside a one-item loop;
      // only the diagnostic async context changes between incoming events.
      for (const rawMsg of [traceMessage]) {
      /**
       * ПЕРЕХОД С РЕКЛАМЫ ОТДЕЛЬНЫМ СОБЫТИЕМ (02.10.2026): запоминаем метку для
       * следующего сообщения этого человека и сам ход не запускаем — сказать
       * человек ещё ничего не успел (см. messengers/metaPeerMemory.ts).
       */
      if (rawMsg.referralOnly) {
        traceOutcome("remembered");
        if (rawMsg.fromAd && !customerPropertyContextEnabled()) {
          rememberAdReferral(rawMsg.channel, rawMsg.senderId, {
            adId: rawMsg.adId,
            adRef: rawMsg.adRef,
            adPostId: rawMsg.adPostId,
            adTitle: rawMsg.adTitle,
          }, Date.now(), customerPropertyContextEnabled() ? rawMsg.accountExternalId : undefined);
        }
        continue;
      }
      const rememberedAd = customerPropertyContextEnabled() ? propertyReferrals.get(rawMsg) ?? null
        : !rawMsg.isEcho && !rawMsg.fromAd ? takeAdReferral(rawMsg.channel, rawMsg.senderId) : null;
      const msg = rememberedAd ? { ...rawMsg, fromAd: true, ...rememberedAd } : rawMsg;
      /**
       * ПОВТОРНАЯ ДОСТАВКА. Проверяем ПЕРВЫМ делом, до скачивания вложений и до
       * всякой платной работы: дубль приходит именно тогда, когда мы не успели
       * ответить 200, то есть в самый неудачный момент. Второй ответ бота на одну
       * реплику клиент видит как неисправность, а лишняя копия его сообщения
       * остаётся в истории диалога навсегда (см. lib/webhookDedupe.ts).
       *
       * ПРОВЕРКА СТОИТ ДО `try`, И ЭТО ВАЖНО (правка 22.09.2026). Внутри `try`
       * её `continue` попадал в `finally` ниже и ставил `completedAt` ЧУЖОЙ,
       * ещё идущей обработке — той самой, дублем которой это сообщение и
       * является. После рестарта подхват по «протухшей» отметке для неё уже не
       * срабатывал: работа числилась завершённой, хотя оборвалась на середине.
       * В обработчике Telegram в этом же файле дедуп стоит правильно, до `try`
       * (строка 1165) — здесь была асимметрия.
       */
      if (await isDuplicateDelivery(msg.channel, msg.messageId)) { traceOutcome("duplicate"); continue; }
      // ОТВЕТ УЖЕ УШЁЛ КЛИЕНТУ — ставится ПОСЛЕ первого успешного sendMetaMessage
      // (см. catch ниже). Отдельная переменная, а не проверка по `result`: ошибка
      // может случиться и ПОСЛЕ отправки (вторая реплика, stampOutgoingMid), и
      // тогда снимать замок дубля уже нельзя (живой случай 18.09.2026, разбор
      // переписки Ориф/133c76fa).
      let replySent = false;
      let providerAcceptedReply = false;
      let deliveryAccountId: string | null | undefined;
      let deliveryTransport: import("../lib/customerConversationScope.js").CustomerTransportReference | undefined;
    try {
      /**
       * СОТРУДНИК ОТВЕТИЛ РУКАМИ ИЗ ПРИЛОЖЕНИЯ — БОТ ЗАМОЛКАЕТ (17.08.2026).
       *
       * Вопрос владельца: «когда кто-то вручную отвечает в инстаграме, а не в
       * CRM, бот остановится или нет?». Не останавливался: эхо исходящих
       * отбрасывалось в разборе целиком, поэтому CRM о таком ответе не узнавала
       * вовсе — бот продолжал вести диалог параллельно с живым человеком, а в
       * переписке ответа сотрудника не было, и агент потом не понимал, что
       * клиенту уже отвечали.
       *
       * Эхо приходит и на реплики САМОГО БОТА — их надо пропускать молча, иначе
       * бот глушил бы сам себя после каждого своего сообщения. Различаем по
       * mid: у всего, что отправили мы, он записан в переписке (stampOutgoingMid).
       */
      if (msg.isEcho) {
        await handleOutgoingEcho(msg);
        continue;
      }

      // Чей это разговор: маркер найденного аккаунта уходит и в индикаторы
      // «прочитано/печатает», и в сам ответ, и в служебные запросы вроде
      // резолва имени по профилю — иначе человек, написавший во второй
      // аккаунт, получил бы ответ от первого (messengers/accounts.ts).
      const account = await resolveIncomingAccount(msg.channel, msg.accountExternalId, msg.senderId);
      deliveryAccountId = account.id;
      const customerTransport = await resolveCustomerEndpoint({ channel: msg.channel, subscriberId: msg.senderId,
        accountId: account.id, accountExternalId: msg.accountExternalId });
      deliveryTransport = customerTransport;

      /**
       * ШАБЛОННАЯ КАРТОЧКА БЕЗ ТЕКСТА — ТА ЖЕ ЗАЩИТА, ЧТО В `handleOutgoingEcho`
       * (см. комментарий там, 22.08.2026), НО ДЛЯ ЭТИХ ДВУХ ВЕТОК НИЖЕ (07.09.2026).
       *
       * `handleOutgoingEcho` ловит карточку, только когда Meta прислала её с
       * `isEcho: true`. При отказе `sendButtonCard` (mid не запомнен) карточка
       * иногда приходит БЕЗ этого флага — обычным «входящим» сообщением — и тогда
       * попадает в одну из веток ниже (человек написал сам себе / бот заглушен
       * лид-магнитом). Обе ветки строили `written` из `msg.attachmentType`, не
       * различая, откуда взялось вложение, — карточку молча записывали как
       * `[вложение: template]`, будто её отправил собеседник, хотя отправить
       * шаблон с кнопкой способна только сама CRM.
       */
      const isBareTemplateEcho = !msg.text && msg.attachmentType === "template";

      /**
       * ПИШЕТ НАШ ЖЕ АККАУНТ — САМОЕ ПЕРВОЕ, ЧТО ПРОВЕРЯЕМ (16.08.2026).
       *
       * Наши два Instagram написали друг другу, и два бота вежливо прощались по
       * кругу два десятка сообщений подряд, пока владелец не остановил это руками.
       * Проверка стоит выше воронки и выше скачивания вложений: разговор с самим
       * собой не должен стоить ни одного платного действия, а ответить на него
       * нельзя вовсе — у обоих ботов на любую реплику найдётся вежливый ответ, и
       * само оно не кончится никогда.
       *
       * Сообщение при этом сохраняем: переписка остаётся в CRM целиком, владелец
       * видит, что было. Молчит только бот (см. lib/ownAccountGuard.ts).
       *
       * ЖИВОЙ РЕЗОЛВ ИМЕНИ МОЖЕТ МОЛЧАТЬ (15.09.2026). Meta блокирует запросы
       * профиля на 24ч при subcode 33 («Object does not exist», см.
       * fetchInstagramProfile) — ровно это произошло с IGSID собственного
       * аккаунта после утренней петли. Без имени isOwnAccountSender сверяет
       * только идентификаторы, а они у эха НИКОГДА не совпадают с externalId
       * (см. комментарий в lib/ownAccountGuard.ts) — защита слепла именно
       * тогда, когда нужна больше всего, и петля возобновилась после того как
       * истекла короткая пауза оффтопика. Резервный путь — имя, которое сам же
       * бот уже сохранил в этом диалоге при прошлом успешном резолве: пока
       * живой запрос недоступен, оно не меняется.
       */
      const senderName =
        msg.name ??
        (await resolveInstagramName(msg.channel, msg.senderId, account.token, account.id, customerTransport)) ??
        (
          await findScopedBotConversation({ channel: msg.channel, subscriberId: msg.senderId, transport: customerTransport })
            .then(native => native ? prisma.botConversation.findUnique({ where: { id: native.id }, select: { name: true } }) : null)
        )?.name ??
        undefined;
      if (await isOwnAccountSender({ senderId: msg.senderId, senderName })) {
        const written = isBareTemplateEcho ? "" : msg.text || (msg.attachmentType ? `[вложение: ${msg.attachmentType}]` : "");
        if (written) {
          await processMessengerTurn({
            channel: msg.channel,
            subscriberId: msg.senderId,
            text: written,
            silent: true,
            fromStaff: true,
            accountExternalId: msg.accountExternalId,
            customerTransport,
            name: senderName,
          });
        }
        // Пауза на годы вперёд: она же снимается вручную, если однажды владелец
        // захочет переписываться между аккаунтами сам. Условие — «нет ДЕЙСТВУЮЩЕЙ
        // паузы», а не «пауза никогда не ставилась»: истёкшая короткая пауза (после
        // ручного ответа сотрудника) остаётся в поле прошедшей датой, а не null, и
        // прежний фильтр `pausedUntil: null` молча пропускал такие диалоги (26.08.2026).
        // Действующую (в т.ч. уже вечную) паузу не перетираем.
        await prisma.botConversation
          .updateMany({
            where: {
              channel: msg.channel,
              subscriberId: msg.senderId,
              OR: [{ pausedUntil: null }, { pausedUntil: { lte: new Date() } }],
            },
            // botPausedAt — с какого момента началась пауза (шаг 5 переноса, 10.09.2026).
            data: { pausedUntil: ownAccountPauseUntil(), botPausedAt: new Date() },
          })
          .catch(() => {});
        console.warn(`[вебхук] ${msg.channel}: входящее от нашего же аккаунта ${senderName ?? msg.senderId} — бот молчит`);
        continue;
      }

      /**
       * НАСТОЯЩЕЕ ВХОДЯЩЕЕ — ДЛЯ ЩИТА ИСХОДЯЩИХ (17.09.2026), И ОБЯЗАТЕЛЬНО ДО
       * ВОРОНКИ ЛИД-МАГНИТА (найдено 18.09.2026 при починке lead-magnet-flow.test.ts).
       *
       * Раньше этот вызов стоял ниже, перед `processMessengerTurn`, — но воронка
       * лид-магнита обрабатывает сообщение и делает `continue` ДО того места, а
       * значит для каждого нажатия кнопки «Хочу чек-лист» / «Я подписался» щит
       * никогда не узнавал, что это настоящий человек. Щит помнит только исходящие,
       * отправленные через `sendMessage` (deliveredText и ссылка воронки — именно
       * они, см. `send()` в lib/leadMagnet.ts), и без отметки настоящего входящего
       * классифицирует их как «инициативу бота», а не «ответ». Инициативе повтор
       * запрещён сразу — поэтому вторая по счёту выдача чек-листа тому же человеку
       * (повторная доставка по просьбе, второй нажатый «я подписался» и т.д.) молча
       * блокировалась щитом и ставила диалог на паузу, хотя оба сообщения были
       * законным ответом воронки живому человеку.
       *
       * Отмечаем ДО развилки на воронку/обычного бота, и это принципиально: здесь
       * же снимается пауза, которую щит мог поставить сам, а лид-магнит обязан
       * успеть ответить на то самое сообщение, которым человек вернулся (владелец:
       * «не нужно, чтобы бот молчал как рыба настоящим клиентам»).
       *
       * `msg.messageId` обязателен: настоящее входящее отличает от подделки,
       * дописанной нашим же кодом, именно идентификатор провайдера — на этом и
       * сгорел сторож номеров 17.09.
       */
      const originalRouting = inspectCustomerDmRouting(customerDmRoutingForIncoming(req, rawMsg));
      if (originalRouting && originalRouting.execution.lane !== "LEGACY") { traceOutcome("blocked"); continue; }
      const currentNative = await findScopedBotConversation({ channel: msg.channel, subscriberId: msg.senderId, transport: customerTransport });
      const currentHistory = currentNative ? await prisma.botConversation.findUnique({ where: { id: currentNative.id }, select: { messages: true } }) : null;
      const finalCustomerInput = isFinalCustomerInputFrame({ kind: msg.payload ? "postback" : "message", isEcho: msg.isEcho,
        bareTemplateEcho: isBareTemplateEcho, ownAccountSender: false, referralOnly: msg.referralOnly,
        knownOutgoingMid: msg.messageId ? await wasSentByUs(msg.messageId) : false,
        inFlightBotEcho: isOwnInFlightEcho(Array.isArray(currentHistory?.messages) ? currentHistory.messages as EchoHistoryEntry[] : [], msg.text, Date.now()) });
      if (finalCustomerInput) await noteRealInbound({
        channel: msg.channel,
        transport: customerTransport,
        subscriberId: msg.senderId,
        providerId: msg.messageId,
        name: msg.name ?? undefined,
      });

      // Canonical accepted IN happens only after the existing echo/staff/own
      // account classification. Early admissions carry the original order;
      // they never activate BOT ownership by merely having a valid HMAC.
      const admission = propertyAdmissions.get(rawMsg);
      let customerAuthenticatedInput: AuthenticatedCustomerInput | undefined;
      if (admission?.status === "admitted" && msg.messageId && finalCustomerInput) {
          const exactIssuer = await verifyCustomerAccountSignature(req as typeof req & { rawBody?: Buffer }, {
            channel: msg.channel, accountId: account.id, accountExternalId: msg.accountExternalId });
          const publicIssuer = exactIssuer || await verifyPublicCustomerAccountSignature(req as typeof req & { rawBody?: Buffer }, {
            channel: msg.channel, accountId: account.id, accountExternalId: msg.accountExternalId });
          const authenticatedInput = publicIssuer ? captureAuthenticatedCustomerInput(req, { channel: msg.channel, peer: msg.senderId,
            accountExternalId: msg.accountExternalId, eventId: msg.messageId, eventKind: msg.payload ? "postback" : "message", inputText: msg.text ?? "" }) : null;
          const accepted = await prisma.$transaction(async tx => {
            if (customerPropertyContextEnabled()) await reserveCustomerPropertyFocus(tx, admission.ticket);
            // Public legacy focus processing can continue with the existing
            // verified envelope; action state remains held without bound issuer.
            return authenticatedInput ? acceptAuthenticatedCustomerAdmission(authenticatedInput, admission.ticket, tx) : null;
          });
          if (accepted && authenticatedInput) customerAuthenticatedInput = authenticatedInput;
      }



      /**
       * ВОРОНКА ЛИД-МАГНИТА — до скачивания вложений и до модели.
       *
       * Человек нажал нашу кнопку «Хочу чек-лист» или «Я подписался»: ответ на это
       * рассчитывается автоматом, без ИИ (см. lib/leadMagnet.ts). Проверка стоит
       * здесь, потому что дальше начинается платная работа — разбор вложений и ход
       * модели, — а на этой ступени решать нечего: ступень воронки определяется
       * состоянием записи, а не смыслом сообщения.
       *
       * Воронка возвращает `false` всюду, где к ней это не относится, — тогда
       * сообщение идёт обычным путём и его разбирает бот.
       */
      if (
        await tryLeadMagnetMessage({
          channel: msg.channel,
          senderId: msg.senderId,
          text: msg.text,
          payload: msg.payload,
          accountExternalId: msg.accountExternalId,
        })
      ) {
        continue;
      }
      // Владелец выключил передачу разговора боту в этой кампании: человек взял
      // файл и пишет дальше — переписка копится в CRM, но модель не вызывается.
      // Ответит живой агент, если сочтёт нужным.
      if (await leadMagnetSilencesBot(msg.channel, msg.senderId)) {
        // Записываем как есть, без скачивания вложений: платной работы здесь не
        // делаем вовсе — тип вложения помечаем словом, чтобы сотрудник в переписке
        // видел, что человек что-то прислал, а не пустую строку. Шаблонную карточку
        // без текста при этом не пишем вовсе (см. isBareTemplateEcho выше) — её мог
        // прислать только бот сам себе, не человек.
        const written = isBareTemplateEcho ? "" : msg.text || (msg.attachmentType ? `[вложение: ${msg.attachmentType}]` : "");
        if (written) {
          await processMessengerTurn({
            channel: msg.channel,
            subscriberId: msg.senderId,
            text: written,
            silent: true,
            accountExternalId: msg.accountExternalId,
            customerTransport,
            customerAuthenticatedInput,
            customerPropertyAdmission: admission,
            name: msg.name ?? (await resolveInstagramName(msg.channel, msg.senderId, account.token, account.id, customerTransport)),
          });
        }
        continue;
      }

      // Фото и голосовые скачиваем и отдаём модели по-настоящему: она смотрит само
      // изображение и получает расшифровку речи (messengers/attachments.ts). Конвейер
      // когда-то был подключён только к вебхуку сторонней платформы, и при переходе
      // на прямую Meta бот перестал видеть вложения — доходило одно слово «image».
      // У Instagram и Messenger адрес файла лежит в вебхуке, у WhatsApp его надо
      // добыть по идентификатору медиа отдельным запросом с маркером.
      const attachments: AttachmentSource[] = [];
      if (DOWNLOADABLE_ATTACHMENTS.has(msg.attachmentType ?? "")) {
        if (msg.channel === "WHATSAPP") {
          const source = msg.mediaId ? await whatsAppMediaSource(msg.mediaId) : null;
          if (source) attachments.push({ ...source, declaredKind: msg.attachmentType });
        } else if (msg.attachmentUrl) {
          // "ig_reel" — единственный тип с двойным смыслом (см. комментарий у
          // DOWNLOADABLE_ATTACHMENTS): страница чужой/нашей публикации ИЛИ прямой
          // CDN-файл, который клиент снял и прислал сам. Страницу (instagram.com/...)
          // качать не пытаемся — там нечего разбирать, и попытка превратила бы
          // mediaSeen в ложное «видел», хотя фактически ничего не скачано (ветку
          // «клиент показывает на нашу публикацию» ниже это бы включало напрасно).
          // Настоящий CDN-адрес (scontent-*/lookaside*) уходит на скачивание как
          // обычное видео.
          if (msg.attachmentType !== "ig_reel" || !isInstagramLink(msg.attachmentUrl)) {
            // declaredKind — то, чем вложение назвала САМА платформа (Meta:
            // attachments[].type). Без него голосовое из Instagram/Messenger,
            // приходящее файлом .mp4 с видео-заголовком, неотличимо от настоящего
            // видео (attachments.ts: detect()) и попадало в описание сцены Gemini
            // вместо расшифровки речи — платформа честно писала "audio", а этот
            // ответ здесь терялся, потому что просто не передавался дальше
            // (найдено 19.08.2026 по живому диалогу, клиент прислал голосовое).
            attachments.push({ url: msg.attachmentUrl, declaredKind: msg.attachmentType });
          }
        }
      }
      /**
       * ПЕРЕСЛАННЫЙ ПОСТ С CDN META — ТОЖЕ КАРТИНКА (02.10.2026). «share» и
       * «ig_post» в список скачиваемых не входят: у Messenger «share» бывает и
       * ссылкой на чужую страницу. Но когда адрес ведёт на CDN самой Meta, там лежит
       * превью поста — и модель должна его видеть, а не слышать «не открылось».
       */
      if (
        (msg.attachmentType === "share" || msg.attachmentType === "ig_post") &&
        msg.channel !== "WHATSAPP" &&
        isMetaCdnUrl(msg.attachmentUrl)
      ) {
        attachments.push({ url: msg.attachmentUrl!, declaredKind: "image" });
      }
      // Остальные вложения того же сообщения (пачка фото в Instagram/Messenger) —
      // те же правила, что у первого: только скачиваемые типы, страницы Instagram
      // не качаем. До 26.08.2026 хвост пачки терялся молча.
      for (const extra of msg.extraAttachments ?? []) {
        if (!extra.url || !DOWNLOADABLE_ATTACHMENTS.has(extra.type ?? "")) continue;
        if (extra.type === "ig_reel" && isInstagramLink(extra.url)) continue;
        attachments.push({ url: extra.url, declaredKind: extra.type });
      }

      /**
       * ОТВЕТ НА НАШУ ИСТОРИЮ — ЭТО ТОЖЕ КАРТИНКА, А НЕ ТОЛЬКО ФЛАЖОК.
       *
       * Адрес истории приходил и раньше, но использовался как пометка «человек
       * ответил на историю»: боту оставалось переспрашивать, о какой квартире
       * речь. А человек отвечает на историю ровно затем, чтобы НЕ объяснять
       * словами. Теперь адрес идёт в тот же разбор, что и обычное фото.
       */
      // Запоминаем, сколько вложений прислал САМ клиент, до того как мы добавим
      // свои (кадр истории, файл публикации из нашей ленты). Различие держит
      // правило «одна реакция — не разговор» ниже: без него «🔥» на историю
      // перестало бы считаться пустой реакцией — вложение-то появилось, только
      // положили его мы, а не человек.
      const clientAttachmentCount = attachments.length;
      if (msg.replyToStoryUrl) attachments.push({ url: msg.replyToStoryUrl });

      /**
       * ПЕРЕСЛАННАЯ ПУБЛИКАЦИЯ: файл берём в СВОЕЙ ленте, а не по присланному адресу.
       *
       * Meta присылает не файл, а ссылку на публикацию — качать по ней нечего, там
       * страница. Зато Graph отдаёт прямую ссылку на файл наших собственных
       * публикаций, и по короткому коду мы находим её у себя (messengers/ownMedia.ts).
       * Так бот наконец видит то, что ему показывают, даже если карточка объекта к
       * публикации не привязана.
       */
      // Адрес публикации ищем во ВСЁМ сообщении, а не в одном поле: Meta присылает
      // в `attachmentUrl` то ссылку на публикацию, то адрес своего CDN, из которого
      // короткого кода не достать. Прежнее `attachmentUrl ?? msg.text` при непустом
      // CDN-адресе до текста не доходило вовсе — своя же публикация не находилась, и
      // разговор уходил в ветку «видео у меня не открылось» (см. findOwnMedia).
      // Нет кода в адресе — ищем по номеру публикации, который Meta кладёт рядом
      // (MetaIncoming.attachmentMediaId, 02.10.2026).
      const ownMedia = isSharedPost(msg.attachmentType)
        ? ((await findOwnMedia(msg.attachmentUrl, msg.text, ...(msg.extraAttachments ?? []).map((a) => a.url))) ??
          (await findOwnMediaById(msg.attachmentMediaId)))
        : null;
      const ownMediaUrl = ownMedia ? viewableUrl(ownMedia) : undefined;
      if (ownMediaUrl) attachments.push({ url: ownMediaUrl });

      // Пометку типом оставляем только тому, что скачать не вышло или не пытались
      // (стикер, геометка, контакт): иначе к настоящему фото прилипало бы ещё и
      // «[вложение: image]», и модель отвечала бы про пометку, а не про картинку.
      const base =
        msg.text || (msg.attachmentType && attachments.length === 0 ? `[вложение: ${msg.attachmentType}]` : "");
      // Пересланный пост/рилс и ответ на историю — самые горячие обращения: человек
      // показывает пальцем на конкретную квартиру. Достаём из ссылки объект и
      // объясняем боту, о чём речь, иначе он отвечал общими словами или молчал.
      /**
       * ВСЁ, ЧТО ИЗВЕСТНО О ПЕРЕСЛАННОМ ПОСТЕ, — ОДНИМ НАБОРОМ (02.10.2026): адрес,
       * номер публикации и подпись из вложения, наша лента. И подсказка модели, и
       * признак «объект узнан» ниже смотрят на одно и то же — раньше разошлись бы.
       */
      const sharedInput = {
        text: base,
        attachmentType: msg.attachmentType,
        attachmentUrl: msg.attachmentUrl,
        // Видит ли модель само присланное. От этого зависит вся подсказка: «отвечай
        // по тому, что видишь» и «переспроси одним вопросом» — разные указания, и
        // раньше второе уходило всегда, даже когда смотреть было на что.
        mediaSeen: attachments.length > 0,
        ownCaption: ownMedia?.caption,
        ownPermalink: ownMedia?.permalink,
        ownMediaId: ownMedia?.id,
        mediaId: msg.attachmentMediaId,
        postTitle: msg.attachmentTitle,
      };
      let sharedPost = await sharedPostContext(sharedInput);
      /**
       * ПОСЛЕДНИЙ ПУТЬ — НАДПИСИ НА САМОЙ КАРТОЧКЕ (02.10.2026). Ни адрес, ни номер,
       * ни подпись объект не дали, а на CDN лежит сама картинка или ролик: читаем
       * цену и площадь с карточки (messengers/sharedPostCard.ts). Только для
       * пересланного поста и только когда ВСЁ прочее промахнулось.
       */
      // Скриншот нашего объявления присылают и обычным фото (02.10.2026): с него
      // так же читаются цена и площадь. Только фото, которое прислал сам клиент.
      const screenshot = msg.attachmentType === "image" && clientAttachmentCount > 0 ? attachments[0] : undefined;
      const cardRead = sharedPost.propertyId
        ? null
        : isSharedPost(msg.attachmentType)
          ? // Подпись уже сказала «не жильё и не наше», а слов нет — читать ролик
            // Gemini незачем: до 25 секунд и деньги на каждый спам-рилс (QA 02.10.2026).
            captionSaysForeign(msg.attachmentTitle) && !msg.text?.trim()
            ? null
            : await readSharedCard(msg.attachmentUrl, msg.attachmentType === "ig_reel" ? "video" : "image")
          : screenshot
            ? await readCardSource(screenshot)
            : null;
      const cardProperty = cardRead?.property ?? null;
      if (cardProperty) sharedPost = { propertyId: cardProperty.id, unresolved: false };
      const turnHint = await sharedMediaHint({
        ...sharedInput,
        cardPropertyId: cardProperty?.id,
        replyToStoryUrl: msg.replyToStoryUrl,
        // Личное обращение по объекту (владелец 21.08.2026) — без этих двух полей
        // sharedMediaHint только подсказывает модели, но не запоминает интерес
        // клиента для маршрутизации лида агенту-владельцу объекта.
        channel: msg.channel,
        recipientId: msg.senderId,
        accountId: account.id,
        transport: customerTransport,
      });
      /**
       * ТОТ ЖЕ НЕОПОЗНАННЫЙ СЛУЧАЙ, НО ДЛЯ СЧЁТЧИКА ПОВТОРА (см. isUnresolvedSharedPost
       * в messengers/sharedMedia.ts и MAX_UNRESOLVED_SHARE_REPLIES в ai/replyRepeatGuard.ts) —
       * живой лид «Муродали», четыре чужих рилса подряд без единого слова, и бот на
       * каждый вежливо отвечал заново. Считаем ТОЛЬКО на пересланных публикациях: это
       * самый редкий тип входящего, лишний indexed-запрос к базе для него не страшен.
       * Пришедшего с нашей рекламы (fromAd) не проверяем — тем же исключением, что и
       * у sharedPost ниже: это не чужое видео, а наш собственный ролик.
       */
      /**
       * ПЕРЕСЛАННЫЙ РОЛИК ВАКАНСИИ (17.09.2026).
       *
       * Сущности «пост вакансии» в CRM нет: findSharedProperty ищет код только
       * среди объектов, не находит и отправляет разговор в ветку «видео не
       * открылось, вы такую квартиру ищете?» — кандидату на вакансию. Список
       * кодов правится в Настройках (lib/vacancyPosts.ts), умолчание в коде.
       */
      const sharedCode =
        instagramShortcode(msg.attachmentUrl) ?? instagramShortcode(base) ?? instagramShortcode(ownMedia?.permalink);
      // Помним, что эту публикацию прислал сам клиент: показ объекта не отправит
      // ему обратно ссылку на тот же рилс (messengers/clientSharedPosts.ts, 25.09.2026).
      rememberClientSharedPost(msg.channel, msg.senderId, sharedCode);
      const vacancyPost = await isVacancyPostCode(sharedCode);
      /**
       * ЧУЖОЙ РОЛИК БЕЗ ЕДИНОГО СЛОВА И НЕ ПРО ЖИЛЬЁ — МОЛЧИМ (владелец 02.10.2026,
       * переписки: игры, девушка в кадре, сбор денег). Готовое «видео не
       * открылось, вы такую квартиру ищете?» на каждый такой ролик читалось как
       * автомат. Сообщение сохраняется в переписку — агент его видит; ответ будет,
       * как только человек напишет словами. С рекламы и по подписи с признаками
       * жилья (цена, комнаты, м²) — отвечаем как раньше.
       */
      // Наш же ролик рекламы, присланный обратно: номер публикации совпал с номером
      // поста объявления, или в подписи наше имя. Чужим его считать нельзя — иначе
      // на собственную рекламу молчание (QA 02.10.2026).
      const adPostTail = msg.adPostId?.includes("_") ? msg.adPostId.slice(msg.adPostId.lastIndexOf("_") + 1) : msg.adPostId;
      const ourCreative =
        (Boolean(msg.attachmentMediaId) && (msg.attachmentMediaId === msg.adPostId || msg.attachmentMediaId === adPostTail)) ||
        isOurBrandCaption(msg.attachmentTitle);
      const foreignShare =
        isSharedPost(msg.attachmentType) && !sharedPost.propertyId && !ownMedia && !vacancyPost && !ourCreative;
      if (foreignShare) rememberForeignShare(msg.channel, msg.senderId);
      // Слова к промолчанному чужому ролику приходят отдельным событием — без дела
      // молчим и на них (messengers/metaPeerMemory.ts, 03.10.2026).
      const followsSilentShare =
        !msg.attachmentType && recentSilentShare(msg.channel, msg.senderId) && !clientTalksBusiness(msg.text);
      const silentForeignShare =
        followsSilentShare ||
        silentOnForeignShare({
          foreignShare,
          fromAd: Boolean(msg.fromAd),
          text: msg.text,
          caption: msg.attachmentTitle,
          card: cardRead,
        });
      if (silentForeignShare) rememberSilentShare(msg.channel, msg.senderId);
      /**
       * ЧТО ИМЕННО ПРИСЛАЛИ — БЕЗ КОРОТКОГО ЗАМЫКАНИЯ ПО fromAd (17.09.2026, вечер).
       *
       * Раньше здесь стоял `isUnresolvedSharedPost`, и для рекламного сообщения он
       * НЕ ВЫЗЫВАЛСЯ вовсе (`!msg.fromAd &&` слева). То есть про рекламу нельзя
       * было узнать, опознан её объект или нет, и бот спрашивал «какую квартиру вы
       * ищете» вместо разговора про ту самую квартиру из ролика. Теперь спрашиваем
       * всегда и одним запросом получаем оба ответа; прежний смысл
       * `unresolvedSharedPost` (счётчик повторов неопознанных пересылок) сохранён
       * ровно теми же двумя условиями, только ниже.
       */
      const unresolvedSharedPost = !msg.fromAd && !vacancyPost && sharedPost.unresolved;
      /** Объект из объявления опознан — он переживёт нейтральный вопрос (adPropertyId). */
      /**
       * ОБЪЕКТ НАШЕЙ РЕКЛАМЫ — НЕ ТОЛЬКО ПО ПЕРЕСЛАННОМУ (02.10.2026). Объявление
       * чаще приходит БЕЗ узнаваемого вложения (голосовое, текст, «сообщение
       * недоступно»), и раньше объект брался только из пересылки — бот отвечал
       * «какую квартиру ищете» человеку с рекламы конкретной квартиры. Теперь и по
       * объявлению: таблица Ad, номер публикации и подпись из метки рекламы.
       */
      // Объявления нет в таблице Ad (не попало в выборку синка) — догружаем его из
      // Meta по номеру, иначе объект и его агент теряются (03.10.2026, «почему Ноза»).
      if (msg.fromAd && !vacancyPost && !sharedPost.propertyId && msg.adId) await ensureMetaAdKnown(msg.adId);
      const adPropertyId =
        msg.fromAd && !vacancyPost
          ? (sharedPost.propertyId ??
            (await adReferralPropertyId({
              adId: msg.adId,
              adPostId: msg.adPostId,
              adTitle: msg.adTitle,
              // Подпись ролика, к которому пришло сообщение, — запасной путь, когда
              // объявление так и не прочиталось: реклама наша, подпись тоже.
              mediaCaption: msg.attachmentTitle,
            })))
          : null;
      traceResolution("ad", adPropertyId);
      traceResolution("shared", sharedPost.propertyId);
      /**
       * Пересланная публикация чужая или наша — для проверки на накрутку.
       * Решение одной функцией (lib/incomingSpam.ts): раньше оно стояло здесь
       * строчкой, и ЛЮБОЙ приход с рекламы выключал проверку целиком.
       */
      const spamContext = sharedPostSpamContext({
        // «Лайк» отдельным сообщением сразу после чужого ролика — та же накрутка.
        sharedPost: isSharedPost(msg.attachmentType) || recentForeignShare(msg.channel, msg.senderId),
        ownMedia: Boolean(ownMedia),
        // Освобождает от проверки на накрутку только объект, узнанный по САМОЙ
        // пересылке: объявление может быть нашим, а присланный к нему ролик — чужим.
        adProperty: Boolean(msg.fromAd && sharedPost.propertyId),
        // Объект узнан по базе — это наш пост, даже если наша лента не прочиталась.
        // Без этого голый пересланный пост уходил в готовую фразу «видео не
        // открылось» (ai/offTopicGuard.ts, blind_share) при уже узнанном объекте —
        // ровно случай владельца 02.10.2026.
        recognizedProperty: Boolean(sharedPost.propertyId),
        vacancyPost,
      });
      /**
       * ЧЕЛОВЕК ПРИШЁЛ ПО НАШЕЙ РЕКЛАМЕ — ЭТО САМЫЙ ДОРОГОЙ ВХОД (17.08.2026).
       *
       * Meta присылает такое сообщение с меткой referral (source=ADS, ad_id), а
       * превью ролика — обычным вложением, которое мы открыть не можем. Живой
       * случай: клиент нажал «Написать» под нашим же роликом и спросил «можно
       * узнать подробнее?», а бот ответил «вложение не открылось». За показ этого
       * ролика заплачено, и не узнать собственную рекламу — худшее, что можно
       * сделать с таким обращением.
       *
       * Подсказка про рекламу СТАРШЕ подсказки про вложение и заменяет её: там
       * сказано «скажи, что видео не открылось», а здесь это прямо запрещено.
       *
       * ТИП РЕКЛАМЫ ПО adRef (02.09.2026, живой случай: таргет на вакансию «Менеджер
       * по продажам недвижимости» дал переходы, а бот всем подряд отвечал «какую
       * квартиру ищете» — подсказка ниже раньше считала ЛЮБУЮ рекламу рекламой
       * объекта безусловно).
       *
       * adRef — это referral.ref, свободная метка, которую рекламодатель может
       * задать в Ads Manager на кнопке перехода. Но обычный «Продвигать публикацию»
       * прямо из приложения (как эта вакансия) такой метки вообще не даёт —
       * полагаться только на неё нельзя, иначе фикс работает лишь для кампаний,
       * которые кто-то не забыл размечать руками. Поэтому три случая, не два:
       *  - метка есть и похожа на вакансию → сценарий JOB прямо;
       *  - метки нет вовсе → НЕЙТРАЛЬНАЯ подсказка: пусть модель поймёт по смыслу
       *    сообщения или спросит сама, если непонятно — раньше здесь было жёсткое
       *    «про квартиру», из-за него вакансия и терялась;
       *  - метка есть и НЕ похожа на вакансию → прежнее поведение (про объект).
       */
      // WhatsApp click-to-message даёт не свободную метку, а headline/body самого
      // объявления (17.09.2026, meta.ts::referral) — тот же regex ниже её и ловит.
      const channelLabel = msg.channel === "WHATSAPP" ? "WhatsApp" : "Instagram";
      const adRefLower = (msg.adRef ?? "").toLowerCase();
      // Регулярка переехала в ai/adTemplateOpener.ts: тот же вопрос задаётся при
      // разборе пересланного ролика вакансии и при восстановлении признака
      // вакансии на следующих ходах — две копии разошлись бы на первой правке.
      const isJobAd = isJobAdRef(adRefLower);
      /** О чём реклама/публикация по referral — переживает первое сообщение (BotConversation.adTopic). */
      const referralAdTopic: "job" | "property" | undefined =
        isJobAd || vacancyPost ? "job" : msg.fromAd && adRefLower ? "property" : undefined;
      /**
       * REFERRAL НЕ ОПОЗНАЛ ТИП — СПРОСИТЬ НАШУ ТАБЛИЦУ Ad (25.09.2026, аудит
       * «кто вообще кандидат»). У WhatsApp click-to-message метки часто нет
       * вовсе, хотя сама реклама (кампания «приемка ...») однозначно говорит,
       * что это реклама ДЛЯ СОБСТВЕННИКОВ — а бот из-за этого спрашивал
       * продавцов «вам квартира или вакансия?». `msg.adId` — тот же
       * `adExternalId`, что уходит в processMessengerTurn ниже.
       */
      const dbAdTopic =
        referralAdTopic === undefined && msg.fromAd && msg.adId ? await adTopicByExternalId(msg.adId) : undefined;
      /** Итоговый тип рекламы: своё мнение референсной метки старше, таблица Ad — только когда та промолчала. */
      const adTopic: AdTopic | undefined = referralAdTopic ?? dbAdTopic;
      const isSellerAd = adTopic === "seller";
      /**
       * ЧЕЛОВЕК НЕ НАПИСАЛ НИЧЕГО СВОЕГО — СПРАШИВАЕМ, ЧЕМ ПОМОЧЬ (владелец
       * 17.09.2026, вечер, по живой проверке).
       *
       * Дословно: «пусть ИИ бот просто спросит, по какому вопросу они обращаются
       * или как он может им помочь, чтобы не ошибаться, а то непонятно, кто за
       * вакансиями, кто за квартирами».
       *
       * Подсказка СТАРШЕ и вакансии, и объекта: даже когда referral опознан, по
       * одной подставленной кнопкой фразе мы не знаем о человеке ничего, а
       * реклама квартир и реклама вакансии идут одновременно. Контекст не
       * теряется — он уезжает в adTopic/adPropertyId и подставится следующим
       * ходом, как только человек ответит хоть словом.
       */
      // Голосовое — это сказанные слова, а не «ничего»: расшифровка приходит в ход
      // позже (conversation.ts), а здесь текст пуст. Раньше на голосовое с рекламы
      // уходила подсказка «спроси, чем помочь» поверх уже сказанного (02.10.2026).
      const nothingSaidYet =
        clientSaidNothingSubstantive(base) && msg.attachmentType !== "audio" && msg.attachmentType !== "voice";
      const adHint = (msg.fromAd || vacancyPost) && nothingSaidYet
        ? neutralOpenerHint(isSellerAd ? "seller" : undefined)
        : msg.fromAd || vacancyPost
        ? isJobAd || vacancyPost
          ? vacancyTurnHint(channelLabel)
          : isSellerAd
          ? sellerTurnHint(channelLabel)
          : adRefLower
            ? `[человек написал ПРЯМО С НАШЕЙ РЕКЛАМЫ в ${channelLabel} — он смотрит наш ролик про квартиру ` +
              "и спрашивает по нему. ЗАПРЕЩЕНО говорить, что вложение или видео не открылось: это наша же " +
              "реклама, и такой ответ читается как отказ. Поздоровайся и спроси ОДНО: какую квартиру он " +
              "ищет — сколько комнат и в каком районе. Дальше веди обычный разговор о покупке]"
            : `[человек написал ПРЯМО С НАШЕЙ РЕКЛАМЫ в ${channelLabel} — у нас ОДНОВРЕМЕННО может идти реклама ` +
              "и квартир, и вакансии «Менеджер по продажам недвижимости», а метка о том, какая именно, " +
              "для этого перехода не пришла. ЗАПРЕЩЕНО говорить, что вложение или видео не открылось: это " +
              "наша же реклама. Пойми по смыслу ЕГО СЛОВ, что ему нужно — квартира или работа у нас. Если " +
              "по тексту неясно (например, он просто нажал «написать» и ничего не сказал) — поздоровайся " +
              "и спроси ОДНО: его интересует квартира или вакансия «Менеджер по продажам недвижимости»? " +
              "Дальше веди соответствующий сценарий — покупку или разговор о работе]"
        : "";
      const text = base;
      // Фото без подписи — это пустой текст, но НЕ пустое сообщение: раньше такой
      // ход отбрасывался здесь, и клиент, приславший одну картинку, ответа не получал.
      if (!text && attachments.length === 0) continue;

      /**
       * ОДНА РЕАКЦИЯ — НЕ РАЗГОВОР. Решение владельца 02.08.2026.
       *
       * Человек щёлкнул «🔥» на нашу историю — это лайк, а не обращение. Ответ на
       * него выглядит навязчиво: бот начинает разговор, которого никто не начинал, и
       * ещё задаёт вопрос. Отвечаем только на слова и вопросы.
       *
       * Вложения проверяются отдельно: фотография или голосовое БЕЗ подписи — это
       * полноценное сообщение, там человек показывает квартиру и ждёт ответа.
       *
       * МОЛЧИМ МОДЕЛЬЮ, НО НЕ ТЕРЯЕМ. Первая версия просто пропускала такое
       * сообщение (`continue`) — и вместе с ответом пропадал сам факт обращения:
       * реакция не появлялась ни в переписке CRM, ни в инбоксе агента, диалог не
       * поднимался, а человек, откликнувшийся на нашу историю, потом получал
       * напоминание «вы не отвечаете». Владелец просил не отвечать МОДЕЛЬЮ, а не
       * делать вид, что человека не было: код в sharedMedia.ts называет такого
       * клиента самым горячим из всех.
       *
       * СМАЙЛИК НА СМАЙЛИК. Решение владельца 16.08.2026: полное молчание на «🔥»
       * выглядело как зависшая переписка, хотя ответ и не нужен целым сообщением.
       * Ответ — один смайлик, без модели, тем же приёмом, что уже под комментариями
       * (comments.ts: emojiThanksReply) — коротко, быстро, без похожести на бота.
       * Грубые смайлики (🖕 и подобные) реакцией не считаются — тем отвечает модель.
       */
      // Считаем ТОЛЬКО вложения клиента: кадр истории и файл нашей публикации
      // добавили мы сами, и они не делают «🔥» разговором. Без этой поправки
      // скачивание историй (16.08.2026) отменило бы решение владельца от 02.08 —
      // бот начал бы отвечать на каждый лайк истории.
      // Грубый смайлик (🖕 и подобные) — не «реакция, на которую отвечаем смайликом»,
      // а повод для настоящего ответа: пусть решает модель, как под комментариями.
      const reactionOnly = clientAttachmentCount === 0 && isReactionOnly(text) && !RUDE_EMOJI.test(text);

      /**
       * ПРОСЬБА О ДЕНЬГАХ — ПОЛНОЕ МОЛЧАНИЕ, ДАЖЕ БЕЗ «ПРОЧИТАНО» (владелец
       * 21.08.2026, разбор живого случая: женщина попросила в директе помочь
       * деньгами). Подробное «почему без mark_seen» — в ai/moneyRequestGuard.ts.
       * Проверяем ДО отправки «прочитано» ниже — иначе галочка уже ушла бы.
       */
      const moneyRequestOnly = !reactionOnly && looksLikeMoneyRequest(text);

      /**
       * РАССЫЛКА И РАЗГОВОР НЕ ПО ДЕЛУ — ТО ЖЕ ПОЛНОЕ МОЛЧАНИЕ, ЧТО У ПРОСЬБЫ О
       * ДЕНЬГАХ ВЫШЕ (владелец 21.08.2026: «на спам сообщения и похожие тоже так
       * делай, без ответа оставь»).
       *
       * Предварительная проверка ЗДЕСЬ нужна ТОЛЬКО ради «прочитано» ниже: успеть
       * решить ДО отправки mark_seen, чтобы её не отправлять вовсе. Настоящее
       * решение (отвечать/молчать) всё равно принимает processMessengerTurn —
       * conversation.ts знает clientId и не считает спамом сообщение своего
       * клиента (см. известного клиента там). Здесь clientId ещё не известен —
       * дешевле смириться с тем, что у своего клиента, чьё сообщение случайно
       * похоже на спам-фразу, галочка «прочитано» иногда не появится вовремя
       * (чистая косметика, см. showReadAndTyping), чем тянуть сюда весь
       * getConversation ради одной проверки.
       */
      const guardSilentOnly = !reactionOnly && !moneyRequestOnly && screenIncomingText(text).action === "silent";

      // Имитация человека за телефоном: секунда-другая на «увидел уведомление»,
      // затем сообщение становится прочитанным и появляется «печатает…». Идёт
      // параллельно с раздумьями ИИ — косметика не задерживает ответ, а
      // заполняет паузу, пока он готовится.
      // Рубильник ЭТОГО канала: в выключенном Instagram галочек быть не должно,
      // даже если в соседнем WhatsApp бот отвечает как ни в чём не бывало.
      // Сразу — только «прочитано». «Печатает…» здесь стояло раньше и означало
      // неправду: до ответа проходит окно ожидания (клиент дописывает) плюс время
      // модели, а Meta гасит индикатор через ~25 секунд. Человек видел «печатает»
      // долго, потом тишину, потом внезапное сообщение. Теперь индикатор
      // включается перед самой отправкой, ниже.
      // На пустую реакцию индикатор «прочитано» не ставим: галочки — это тоже
      // ответ, а мы решили молчать.
      // account уже определён в начале обработки сообщения (нужен и воронке, и
      // резолву имени выше).
      // Накрутке («лайк» после чужого ролика) и галочек не ставим: ответа не будет
      // (QA 02.10.2026). Окончательно спам решает ход (conversation.ts), здесь —
      // та же проверка заранее, только ради «прочитано».
      const looksSpam = Boolean(detectSpam(text, spamContext));
      if (
        bot.channels[msg.channel] &&
        !reactionOnly &&
        !moneyRequestOnly &&
        !guardSilentOnly &&
        !silentForeignShare &&
        !looksSpam
      ) {
        void sleep(800 + Math.random() * 1700).then(() =>
          showMetaReadAndTyping(msg.channel, msg.senderId, msg.messageId, false, account.token, customerTransport)
        );
      }

      // Настоящее входящее для щита исходящих отмечено выше, до развилки на
      // воронку лид-магнита и обычного бота (см. комментарий там же).

      if (!bot.channels[msg.channel]) traceOutcome("bot_off");
      const result = await processMessengerTurn({
        accountExternalId: msg.accountExternalId,
        customerTransport,
        customerAuthenticatedInput,
        customerPropertyAdmission: propertyAdmissions.get(rawMsg),
        customerPropertyEventKind: rawMsg.payload ? "postback" : "message",
        channel: msg.channel,
        subscriberId: msg.senderId,
        text,
        // Реклама важнее вложения: её подсказка прямо запрещает говорить, что
        // видео не открылось (см. adHint выше).
        // Объект рекламы опознан и человек уже что-то сказал — подсказка про ЭТОТ
        // объект (turnHint от sharedMediaHint) важнее общего «спроси, какую
        // квартиру он ищет» из adHint. Неопознанную пересылку по-прежнему
        // перебивает adHint: в ней лежит запрещённое «видео не открылось».
        // Объект рекламы известен по объявлению, а пересылку не узнали: пустая
        // подсказка — тогда conversation.ts подставит adPropertyHint про ЭТОТ объект,
        // а не «видео не открылось» и не «какую квартиру ищете» (02.10.2026).
        turnHint:
          adPropertyId && !nothingSaidYet
            ? sharedPost.propertyId
              ? turnHint || adHint
              : isJobAd || isSellerAd
                ? adHint || turnHint
                : ""
            : adHint || turnHint,
        adPropertyId,
        // Объект, узнанный по присланному посту/ссылке/карточке — только след в
        // диалоге («голос рынка», 03.10.2026); на ответ бота не влияет.
        sharedPropertyId: sharedPost.propertyId ?? null,
        // О чём была реклама — доезжает до диалога и восстанавливается на всех
        // следующих ходах (messengers/conversation.ts): признак вакансии жил
        // ровно одно сообщение и терялся со второго.
        adTopic,
        // Пересланная публикация и наша ли она: по этой паре отсекается накрутка
        // лайков (чужой ролик + «поставь лайк»), см. lib/incomingSpam.ts.
        // Пришедшего с НАШЕЙ рекламы «чужим видео» не считаем никогда.
        /**
         * ПРИХОД С РЕКЛАМЫ БОЛЬШЕ НЕ ОСВОБОЖДАЕТ ОТ ПРОВЕРКИ НА НАКРУТКУ
         * (жалоба владельца 21.09.2026: «на спам отвечает, когда по рекламе нам
         * отправляют своё видео»).
         *
         * Раньше любой `fromAd` выключал проверку целиком: `sharedPost` становился
         * false, а `ourSharedPost` — true. Логика была в том, что человек с нашей
         * рекламы пересылает нашу же публикацию. Но реклама — это ровно то, как нас
         * НАХОДЯТ рассылки: спамер кликает объявление и присылает свой ролик с
         * «подпишись, поставь лайк», а проверка на него не смотрела вовсе.
         *
         * Освобождение оставлено там, где мы ДЕЙСТВИТЕЛЬНО знаем, что показывают
         * своё: публикация опознана в нашей ленте (`ownMedia`), объявление
         * сопоставлено с объектом (`adPropertyId`) или это пост вакансии. В
         * остальных случаях работает обычное правило, заведомо трусливое: одного
         * подозрительного слова никогда не хватает (lib/incomingSpam.ts).
         */
        sharedPost: spamContext.sharedPost,
        ourSharedPost: spamContext.ourPost,
        // Повтор нераспознанной пересылки — считает и решает conversation.ts
        // (MAX_UNRESOLVED_SHARE_REPLIES), сюда пришёл уже готовый признак ЭТОГО хода.
        unresolvedSharedPost,
        // С какого объявления человек написал — ad_id доезжает до диалога и
        // дальше до карточки (ROMI по объявлению). Раньше выбрасывался здесь.
        adExternalId: msg.adId,
        adClickId: msg.adClickId,
        silent: reactionOnly || moneyRequestOnly || silentForeignShare,
        name: msg.name ?? (await resolveInstagramName(msg.channel, msg.senderId, account.token, account.id, customerTransport)),
        attachments,
        // Для цитат в переписке CRM: чем это сообщение было у Meta и на что клиент
        // отвечал «ответом».
        messageId: msg.messageId,
        replyToMessageId: msg.replyToMessageId,
      });

      // Записали в CRM (см. silent выше) — и на этом всё, ни ответа, ни «прочитано».
      if (moneyRequestOnly) continue;
      // Пустая реакция — ответ смайликом, не через обычный ход ниже: там ответ
      // проверяется общим фильтром, который эмодзи в личке запрещает (правило
      // «без смайликов в личке» — оно для осмысленного текста, а не для этого
      // единственного нарочного исключения).
      //
      // В WhatsApp — НАСТОЯЩАЯ реакция (тап эмодзи на сообщение клиента), не
      // отдельный пузырь в переписке: технически доступно с 18.08.2026
      // (meta.ts: sendReaction). В Instagram/Messenger такого эндпоинта у Meta
      // нет вовсе — там как раньше, отдельным сообщением-смайликом.
      //
      // ГЛАВНОЕ (находка №105, 24.09.2026): смайлик — тоже ответ клиенту, и он
      // обязан подчиняться тем же правилам молчания, что и обычная реплика.
      // `reactionOnly` здесь посчитан ДО processMessengerTurn и сам по себе не
      // знает ни про рубильник канала, ни про паузу, ни про спам-метку — раньше
      // смайлик уходил безусловно. `result.silenced` (conversation.ts) несёт
      // причину, посчитанную ВНУТРИ хода: паузу и спам оттуда наружу больше
      // никак не достать. Рубильник канала проверяем тем же `bot.channels`, что
      // и «прочитано» выше — это тот же самый рубильник, что читает
      // processMessengerTurn (messengers/botChannels.ts).
      if (reactionOnly) {
        // Смайлик сразу после чужого ролика («👍», «🔥») — та же накрутка, что «лайк»:
        // в ответ ничего, ни смайлика (QA 02.10.2026).
        if (bot.channels[msg.channel] && !result.silenced && !recentForeignShare(msg.channel, msg.senderId)) {
          await sendReactionOrEmoji(msg.channel, msg.senderId, msg.messageId, account.token, customerTransport);
        }
        continue;
      }
      if (result.shouldReply === false) {
        // Повторное «спасибо» после того, как прощание уже состоялось (см.
        // reactOnly в processMessengerTurn) — тот же приём, что и reactionOnly
        // выше: реакция вместо нового полноценного хода ИИ. Та же проверка —
        // на случай, если канал выключили или диалог поставили на паузу между
        // сохранением сообщения и этой строкой.
        if (result.reactOnly && bot.channels[msg.channel] && !result.silenced) {
          await sendReactionOrEmoji(msg.channel, msg.senderId, msg.messageId, account.token, customerTransport);
        }
        continue;
      }
      // Вот теперь «печатает…» честное: ответ готов, осталась пауза на «набор».
      //
      // ДОЖИДАЕМСЯ индикатора, а не пускаем его через `void`. Пауза «набора» должна
      // отсчитываться от момента, когда клиент индикатор УВИДЕЛ. Пущенный параллельно
      // запрос в Graph API занимает своё время, и при короткой паузе (минимум 3
      // секунды) сообщение успевало уйти раньше, чем появлялось «печатает…»: человек
      // видел ответ, а следом — «печатает», хотя писать уже нечего.
      if (result.customerPropertyReply) replySent = true; // persisted pending is terminal even if typing fails
      await showMetaReadAndTyping(msg.channel, msg.senderId, msg.messageId, true, account.token, customerTransport);
      await sleep(typingDelayMs(result.reply));
      if (result.customerReplyPrincipal && (await revalidateCustomerPrincipal(result.customerReplyPrincipal)).status !== "current") {
        traceOutcome("blocked");
        continue;
      }
      const sendReplyText = async (text: string): Promise<string | null> => {
        const mid = await sendMetaMessage(msg.channel, msg.senderId, text, account.token, { transport: customerTransport,
          ...(result.customerReplyPrincipal ? { customerReplyPrincipal: result.customerReplyPrincipal } : {}) });
        if (mid) providerAcceptedReply = true;
        return mid;
      };
      if (result.customerPropertyReply) {
        const outcome = await sendManagedCustomerPropertyReply(result.customerPropertyReply,
          () => sendReplyText(result.reply));
        replySent = true; // terminal managed part never releases full-turn dedupe
        if (outcome === "unknown") traceOutcome("incomplete");
        continue;
      }
      // Идентификатор отправленного дописываем к уже записанной реплике: по нему
      // потом найдётся, на что клиент ответил «ответом» (цитата в переписке).
      // Отправляем маркером НАШЕГО аккаунта (account.token) — тем же, в который
      // человек написал, а не маркером из Settings по умолчанию.
      await stampOutgoingMid(
        msg.channel,
        msg.senderId,
        await sendReplyText(result.reply), customerTransport
      );
      // Клиент уже увидел ответ — что бы ни случилось дальше в этом ходе (вторая
      // реплика, mid), снимать замок дубля больше нельзя: повторная доставка от
      // Meta заново прогонит processMessengerTurn и пришлёт клиенту ВТОРОЙ, слегка
      // другой по формулировке ответ на тот же вопрос («два похожих сообщения
      // подряд» из живой переписки).
      replySent = true;
      if (result.reply2) {
        // Между двумя сообщениями индикатор гаснет (отправка его сбрасывает) —
        // показываем «печатает…» заново, как человек, который дописывает мысль.
        await showMetaReadAndTyping(msg.channel, msg.senderId, undefined, true, account.token, customerTransport);
        await sleep(typingDelayMs(result.reply2, 6000));
        if (result.customerReplyPrincipal && (await revalidateCustomerPrincipal(result.customerReplyPrincipal)).status !== "current") {
          traceOutcome("blocked");
          continue;
        }
        await stampOutgoingMid(
          msg.channel,
          msg.senderId,
          await sendMetaMessage(msg.channel, msg.senderId, result.reply2, account.token, { transport: customerTransport,
            ...(result.customerReplyPrincipal ? { customerReplyPrincipal: result.customerReplyPrincipal } : {}) }), customerTransport
        );
      }
      // Голосовая версия ответа — вдогонку тексту, после ПОСЛЕДНЕЙ реплики
      // (см. докстринг deliverBotVoiceReply): clientId/clientName сюда не доезжают
      // (processMessengerTurn их наружу не отдаёт) — честно null, это влияет
      // только на текст тревоги руководству при блокировке, не на саму отправку.
      if (result.replyVoiceWav) {
        traceDeferUntil(deliverBotVoiceReply(msg.channel, msg.senderId, result.replyVoiceWav, { clientId: null, clientName: null }, customerTransport).catch((err) =>
          console.error("[голосовой ответ] meta:", err instanceof Error ? err.message : err)
        ));
      }
    } catch (err) {
      if (err instanceof CustomerReplyHeldError) { traceOutcome("blocked"); continue; }
      /**
       * ЩИТ ИСХОДЯЩИХ НЕ ВЫПУСТИЛ ОТВЕТ — ЭТО РЕШЕНИЕ, А НЕ ПОЛОМКА (17.09.2026).
       *
       * Снимать замок дубля здесь НЕЛЬЗЯ: Meta доставит то же сообщение снова,
       * бот снова упрётся в щит, и вместо петли исходящих получится петля
       * входящих. Причину щит уже записал в журнал и показал руководству.
       */
      if (isOutboundBlockedError(err)) {
        traceOutcome("blocked");
        console.warn(`[щит] ${msg.channel}: ответ не отправлен — ${err.message}`);
        continue;
      }
      console.error("[meta] обработка сообщения упала:", err);
      traceOutcome("failed");
      /**
       * ОТВЕТ, КОТОРЫЙ НЕ УШЁЛ, НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ ОТПРАВЛЕННЫМ (20.09.2026).
       *
       * Реплика бота пишется в переписку ДО отправки, и при отказе Meta (закрытое
       * окно 24 часов, отозванный маркер, 5xx Graph API) в CRM оставался ответ,
       * которого клиент никогда не видел. Сотрудник открывал переписку, видел
       * «бот ответил» и не отвечал сам — человек оставался без ответа вовсе
       * (docs/bot-razbor-20-09.md, класс 7 п. 1). Отметка ставится только если
       * mid'а нет, то есть клиент действительно не получил ничего.
       */
      // A lost local MID stamp is not evidence of failed provider delivery.
      // Two ordinary bubbles share one history element (mid/mid2), so a failed
      // second bubble cannot truthfully mark the accepted first bubble failed.
      if (!providerAcceptedReply) await markLastReplyUndelivered(msg.channel, msg.senderId, deliveryTransport ?? deliveryAccountId);
      // A real provider MID precedes history stamping. Losing that local stamp
      // must not reopen the whole turn or claim that no answer reached the user.
      if (providerAcceptedReply) replySent = true;
      void logSystemError(
        "meta",
        `Сообщение из ${msg.channel} не обработано: ${err instanceof Error ? err.message : String(err)}`
      );
      // Клиент остался без ответа ПРЯМО СЕЙЧАС — не ждать, пока диалог доедет до
      // findStuckConversations (health-automation раз в 30 минут) или до утреннего
      // журнала (24.09.2026, ночная проверка, находка №108).
      if (!providerAcceptedReply) void trackBackgroundTask(notifyBotReplyNotDelivered(msg.channel, msg.senderId, deliveryTransport ?? deliveryAccountId));
      // Замок дубля ставится ДО обработки (см. lib/webhookDedupe.ts). Раз она не
      // дошла до ответа — отметку снимаем, иначе повторная доставка от Meta молча
      // отступит перед «уже обработанным» сообщением, которое на деле осталось без
      // ответа: клиент написал, бот промолчал, и в журнале только одна строчка.
      //
      // НО ТОЛЬКО ЕСЛИ ОТВЕТ ЕЩЁ НЕ УШЁЛ (18.09.2026, диалог 133c76fa: «приняли
      // ваши данные» и тут же переспрос номера тем же текстом). Ошибка ПОСЛЕ
      // sendMetaMessage — сбой в хвосте хода (вторая реплика, mid), а не «клиент
      // без ответа»: снятие замка открывало дверь повторной доставке Meta, и
      // клиент получал второй ответ на тот же вопрос. Сама ошибка в любом случае
      // ушла в журнал строкой выше; недоставленная реплика помечена отдельно
      // (markLastReplyUndelivered).
      if (!replySent) void releaseProcessedMessage(msg.channel, msg.messageId);
    } finally {
      // ОТМЕТКА ЗАВЕРШЕНИЯ (21.09.2026, см. lib/webhookDedupe.ts). `finally`
      // зовётся при ЛЮБОМ нормальном выходе из try — и по одному из ранних
      // `continue` внутри (реакция, эхо, воронка, «промолчали»), и после полного
      // ответа модели, и когда catch выше сам обработал отказ (щит исходящих —
      // замок НЕ снят нарочно, см. комментарий там). Если catch уже снял замок
      // через releaseProcessedMessage, строка удалена — updateMany здесь просто
      // не найдёт что обновлять и тихо ничего не сделает; порядок не важен.
      void markProcessedMessageComplete(msg.channel, msg.messageId);
      // Ответ на наше первое сообщение в WhatsApp — ПОСЛЕ обработки хода: реплика
      // клиента уже в переписке, и ссылка на объект ляжет после неё, а не перед.
      if (msg.channel === "WHATSAPP" && !msg.isEcho) void noteFirstContactReply(msg.senderId, msg.text);
        }
      }
      traceFinishCustomerTurn();
      });
      }
        })
      );
    })().catch((err) => {
      // Ошибка вне внутреннего try (проверка повтора, чтение настроек) иначе
      // пропадала без следа: trackBackgroundTask гасит отказ, и сообщение
      // клиента терялось молча (аудит 23.09.2026, круг 3, №84).
      void logSystemError("meta", `Вебхук Meta: обработка оборвалась: ${describeError(err)}`);
    })
  );
});

/**
 * ОТВЕТ БОТА НЕ ДОШЁЛ — ПУШ ТЕМ, КТО ЧИТАЕТ ПЕРЕПИСКИ (24.09.2026, ночная
 * проверка, находка №108). Отказ Meta (5xx, протухший маркер, закрытое окно
 * 24 часов) раньше оставлял только строку в журнале ошибок — сотрудник, не
 * заглянувший туда специально, не узнавал, что клиент не получил ответ.
 * Реплика уже помечена markLastReplyUndelivered ДО этого вызова; здесь только
 * уведомление, поэтому свой отказ не должен ронять обработку сообщения — как и
 * everywhere else в этом catch, ошибка уходит в журнал, а не наружу.
 *
 * Экспортирована для собственного теста (тот же приём, что у groupMetaBySender
 * ниже) — гонять ради неё весь вебхук с подписью Meta не нужно.
 */
export async function notifyBotReplyNotDelivered(channel: string, subscriberId: string, transport?: CustomerTransportHint): Promise<void> {
  try {
    const conv = transport ? await findScopedBotConversation(customerTransportInput(channel, subscriberId, transport)) : null;
    const recipients = await findAgentsWithPermission("messages.view");
    await sendPushToAgents(recipients, {
      title: "🤖 Доставка ответа требует проверки",
      body: "Не удалось подтвердить доставку ответа в Meta — проверьте переписку клиента.",
      url: conv ? `/messages?open=${conv.id}` : "/messages",
      tag: `bot-reply-failed-${channel}-${subscriberId}`,
    });
  } catch (err) {
    void logSystemError(
      "meta",
      `Не удалось предупредить о недоставленном ответе (${channel}, ${subscriberId}): ${describeError(err)}`
    );
  }
}

/** Пачка вебхука Meta → очереди по собеседнику, порядок внутри каждой сохранён. */
export function groupMetaBySender<T extends { channel: string; senderId: string; accountExternalId?: string }>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = JSON.stringify([item.channel, item.accountExternalId ?? null, item.senderId]);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

/**
 * ОБЛОЖКА ДЛЯ СТАТЬИ БЛОГА — сайт присылает тему, CRM возвращает готовую картинку.
 *
 * ПОЧЕМУ РИСУЕТ CRM, А НЕ САЙТ. Ключ Google уже живёт здесь, зашифрованным в
 * Настройках, под правом `settings.manage`. Отдать его сайту значило бы завести
 * вторую копию секрета: второе место, где менять при ротации, и второй способ
 * потерять. Ротация 22.08.2026 показала цену наглядно — удалив старые ключи в
 * консоли Google, владелец мгновенно остановил бота, и чинить пришлось в двух
 * местах (база и .env). Третьего места быть не должно.
 *
 * Побочная выгода, ради которой это и просили: модель рисования выбирается на том же
 * экране Настройки → ИИ, что и остальные, а расход на картинки виден в общем журнале
 * вызовов ИИ — вместе со всеми, а не отдельной статьёй, о которой все забудут.
 *
 * Аутентификация — тот же общий секрет X-Api-Key, что у приёма заявок: у сайта нет
 * учётки агента, это межсерверный вызов. Без настроенного ключа роут выключен целиком.
 */
const coverImageSchema = z.object({
  /** Тема статьи — из неё строится промт. Не заголовок с сайта дословно: длинная
   *  строка с кавычками и эмодзи рисуется хуже короткой сути. */
  topic: z.string().min(3).max(200),
});

/**
 * Рисование дорогое и медленное (около 20 секунд), поэтому лимит жёстче, чем у
 * синхронизации: десять обложек за четверть часа — это больше, чем блог публикует
 * за неделю, и одновременно надёжный предохранитель от зациклившейся интеграции,
 * которая иначе тихо потратит дневной лимит проекта.
 */
const coverImageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много обложек подряд, попробуйте позже" },
});

/**
 * ПОВТОРНАЯ ДОСТАВКА ЭТОГО ВЕБХУКА — САМАЯ ДОРОГАЯ ИЗ ВСЕХ (22.09.2026).
 *
 * Защиты не было вовсе: retry сайта на плохой связи означал второй платный вызов
 * рисующей модели (~20 секунд), второй файл `uploads/covers/cover-*.jpg` под новым
 * случайным именем (сирота — на него никто не ссылается, первая ссылка уже ушла бы
 * сайту при живом ответе) и вторую ссылку статье.
 *
 * Устойчивого id у доставки нет — сайт присылает только тему статьи (`topic`), без
 * id самой статьи. Ключ строим из темы, как websiteChatDeliveryKey у чата: тот же
 * приём — бакет времени внутри ключа, чтобы повтор темы через день (та же тема
 * для другой статьи, законный случай) не считался вечным дублем. Окно ощутимо шире,
 * чем у чата и заявок (15-30 с): цена повтора здесь не push, а ~20 секунд платного
 * вызова ИИ и файл на диске, так что даём сайту больше времени на честный ретрай.
 *
 * Отметка — по общему замку lib/webhookDedupe.ts: ставится ДО генерации, снимается
 * при отказе (в т.ч. отказе внешнего поставщика), завершается ПОСЛЕ того, как файл
 * записан и ссылка готова — тот же порядок, что у остальных вебхуков.
 */
const SITE_COVER_IMAGE_CHANNEL = "SITE_COVER_IMAGE";
const SITE_COVER_IMAGE_DEDUPE_BUCKET_MS = 5 * 60 * 1000;

function siteCoverImageDeliveryKey(topic: string): string {
  const bucket = Math.floor(Date.now() / SITE_COVER_IMAGE_DEDUPE_BUCKET_MS);
  const canonical = JSON.stringify([topic.trim().toLowerCase(), bucket]);
  return createHash("sha256").update(canonical).digest("hex");
}

webhooksRouter.post("/site-cover-image", coverImageLimiter, async (req, res) => {
  const apiKey = process.env.WEBSITE_LEAD_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Интеграция с сайтом не настроена" });
  }
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }
  const parsed = coverImageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Нужна тема статьи (3–200 символов)" });
  }

  const deliveryKey = siteCoverImageDeliveryKey(parsed.data.topic);
  if (await isDuplicateDelivery(SITE_COVER_IMAGE_CHANNEL, deliveryKey)) {
    return res
      .status(409)
      .json({ error: "Такая обложка уже генерируется или недавно сгенерирована, повторите позже" });
  }

  let result: Awaited<ReturnType<typeof generateCoverImage>>;
  try {
    result = await generateCoverImage(parsed.data.topic);
  } catch (err) {
    void releaseProcessedMessage(SITE_COVER_IMAGE_CHANNEL, deliveryKey);
    throw err;
  }
  if (!result.ok || !result.image) {
    void releaseProcessedMessage(SITE_COVER_IMAGE_CHANNEL, deliveryKey);
    // Причину отдаём сайту дословно: она уже написана человеческим языком (см.
    // ai/coverImage.ts) и объясняет, что чинить — биллинг проекта, имя модели или ключ.
    // 502, а не 500: отказал внешний поставщик, а не мы.
    return res.status(502).json({ error: result.error ?? "Не удалось нарисовать обложку" });
  }

  // Файл кладём в те же `uploads`, что и фотографии объектов: они раздаются статикой
  // и уже открыты миру, а обложка статьи — тем более не секрет. Имя случайное, чтобы
  // две статьи на одну тему не затирали друг другу картинку.
  const name = `cover-${randomBytes(8).toString("hex")}.jpg`;
  const coversDir = path.join(uploadsDir, "covers");
  try {
    await fs.promises.mkdir(coversDir, { recursive: true });
    await fs.promises.writeFile(path.join(coversDir, name), result.image);
  } catch (err) {
    // ЕДИНСТВЕННЫЙ шаг этого обработчика, который умеет бросить при совершенно
    // здоровой базе: кончилось место, права, том только на чтение. Все остальные
    // отказы здесь возвращаются кодом и аккуратно снимают замок — а этот уходил
    // наверх мимо него.
    //
    // Чем это кончалось. Отметка `isDuplicateDelivery` уже стоит и означает
    // «обработка идёт» (lib/webhookDedupe.ts). Исключение мимо замка оставляет её
    // висеть, и каждый честный повтор сайта в пределах пятиминутного окна ключа
    // получает 409 «уже генерируется или недавно сгенерирована» — хотя картинки
    // нет, на диск ничего не легло и никто ничего не рисует. Платный вызов
    // рисующей модели при этом уже сделан и выброшен, а в CRM о сбое не знает
    // никто: ни записи в журнале, ни следа в ответе.
    void releaseProcessedMessage(SITE_COVER_IMAGE_CHANNEL, deliveryKey);
    void logSystemError(
      "api",
      `Обложка статьи нарисована, но не записалась на диск (${coversDir}): ${describeError(err)}`
    );
    // 503, а не 500: отказало наше хранилище, отказ временный и повтор осмыслен —
    // замок снят как раз затем, чтобы повтор прошёл сразу, а не через окно ключа.
    return res.status(503).json({ error: "Обложка нарисована, но не сохранилась на диске CRM" });
  }

  const relative = `/uploads/covers/${name}`;
  const url = publicUploadUrl(relative);
  if (!url) {
    // Без CRM_PUBLIC_URL мы не можем дать сайту работающую ссылку, а относительная
    // на чужом домене ведёт в никуда. Честный отказ лучше битой картинки в статье.
    // Картинка уже нарисована и лежит на диске — снимаем замок, чтобы повтор ПОСЛЕ
    // того, как владелец настроит CRM_PUBLIC_URL, не считался дублем навсегда.
    void releaseProcessedMessage(SITE_COVER_IMAGE_CHANNEL, deliveryKey);
    return res.status(503).json({ error: "Не настроен публичный адрес CRM (CRM_PUBLIC_URL)" });
  }
  void markProcessedMessageComplete(SITE_COVER_IMAGE_CHANNEL, deliveryKey);
  res.json({ url, bytes: result.image.length });
});
