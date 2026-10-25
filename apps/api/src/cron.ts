import { investigationRecipients } from "./lib/investigationNotifications.js";
import { scheduleTracked, checkCronHeartbeats, markCronTickFailed, reportCronTickError } from "./lib/cronHeartbeat.js";
import { runAbsenceReturnTick } from "./lib/absenceReturn.js";
import { cleanupBotTurnTraces } from "./lib/botTurnTraceStore.js";
import { runSocialVideoScheduleTick } from "./lib/socialVideoPosts.js";
import { runBackgroundJobsTick, runCustomerJobsTick } from "./jobs/runner.js";
import { enqueueBackgroundJob } from "./jobs/enqueue.js";
import { AI_REPLY_RETRY_MAX_ATTEMPTS } from "./jobs/aiReplyRetryPolicy.js";
import { scoreAllActiveClients } from "./ai/scoring.js";
import { staleLeadCircleOpen, reassignStaleLeads, reassignStaleReturns, assignPendingLeads, penalizeMissedFirstCalls, remindDueFirstCalls, assignHeldLead, remindEscalatedLeads } from "./leads.js";
import { runInactiveTrafficLightTick } from "./lib/inactiveTrafficLight.js";
import { runDeferredClientsReturnTick } from "./lib/deferredClients.js";
import { escalateSellerPropertyMissing } from "./lib/sellerPropertyMissingAntifraud.js";
import { runSellerNoPropertyAlarmTick } from "./lib/sellerNoPropertyAlarm.js";
import { runSellerWorkStalledAlarmTick } from "./lib/sellerWorkStalledAlarm.js";
import { runVideoHandoffStaleAlarmTick } from "./lib/videoHandoffStaleAlarm.js";
import { runClipReviewStaleAlarmTick, runClipReviewResendTick } from "./telegram/clipReviewBot.js";
import { runVideoHandoffRedeliveryTick } from "./lib/videoHandoffRedelivery.js";
import { runVideoHandoffUnfinishedPublishWatchdogTick } from "./lib/videoHandoffUnfinishedPublishWatchdog.js";
import { runStationOutageProbeTick } from "./lib/stationOutage.js";
import { runAgentUnansweredAlarmTick } from "./lib/agentUnansweredAlarm.js";
import { runBotPauseWatchTick } from "./lib/botPauseWatch.js";
import { runClientPropertyCountAlarmTick } from "./lib/clientPropertyCountAlarm.js";
import { runAgentOffCrmAlarmTick } from "./lib/agentOffCrmAlarm.js";
import { flushDirectorAlertQueue } from "./lib/directorAlertQueue.js";
import { runBuyerThinkingSlowTrackTick } from "./lib/buyerThinkingSlowTrack.js";
import { processNoAnswerTailAnchors } from "./lib/noAnswerStreak.js";
import { calculateDailyKpiForAllAgents } from "./kpi.js";
import { isWithinWorkingHours } from "./lib/workingHours.js";
import { refreshUsdToTjsRateFromAlif } from "./lib/exchangeRate.js";
import { logSystemError, type SystemErrorSource } from "./lib/systemError.js";
import { dushanbeWallClock, DUSHANBE_OFFSET_MS } from "./lib/dushanbeTime.js";
import { runDailyStoriesTick } from "./lib/dailyStories.js";
import { prisma } from "./db.js";
import { sendPushToAgent } from "./push.js";
import { runIncomingCallsSilenceTick } from "./lib/telephony/incomingCallsSilenceAlarm.js";
import { reconcileOperatorQueuePresence } from "./lib/telephony/operatorQueue.js";
import { reconcileAgentMobileFallback } from "./lib/telephony/agentMobileFallback.js";
import { reconcileIncomingQueue } from "./lib/telephony/agentIncomingReadiness.js";
import { runStationHealthTick } from "./lib/telephony/stationHealth.js";
import { runStationTrafficTick } from "./lib/telephony/stationTraffic.js";
import { schedulePhotoPostsTick } from "./lib/photoPosts.js";
import { insightDigestPeriod, isInsightMeetingDay } from "./lib/insightDigestPeriod.js";
import { scheduleRepostsTick } from "./lib/socialReposts.js";
import { runSocialDigestsTick } from "./lib/socialDigests.js";
import {
  notifyMissedShowings,
  notifyOverdueTasks,
  notifySupervisorsOfOverdue,
  notifyUnconfirmedShowings,
  sendHourBeforeReminders,
  sendShowingConfirmationRequests,
  sendTomorrowDigest,
} from "./lib/meetingReminders.js";
import { remindIncompleteCards } from "./lib/cardReminders.js";
import { refreshStatusesByTime } from "./lib/clientAutoStatus.js";
import { refreshPropertyStatusesByTime } from "./lib/propertyAutoStatus.js";
import { runNightlyGeoMatchSweepTick } from "./lib/geoMatchSweep.js";
import { runContactLinkSweepTick } from "./lib/contactLinkSweep.js";
import { generateMonthlyReport } from "./lib/monthlyReport.js";
import { generateProblemReport } from "./lib/problemReport.js";
import { notifyReportsAboutMarketingInsights } from "./lib/marketingInsights.js";
import { runDuplicatesWeeklyDigestTick } from "./lib/duplicatesWeeklyDigest.js";
import { buildSecurityReviewDigest } from "./lib/securityReviewDigest.js";
import { findAgentsWithPermission } from "./lib/recipients.js";
import { pluralizeRu, type ConversationMessage } from "@royal-home/shared";
import { refreshInstagramTokenIfDue } from "./messengers/instagramFeed.js";
import { checkYouTubeTokenHealth, refreshThreadsTokenIfDue } from "./lib/socialPublish.js";
import { runInstagramPendingContainersTick } from "./lib/instagramPendingContainers.js";
import { runInstagramSubscriptionWatch } from "./lib/instagramWebhookSubscription.js";
import { collectInstagramOnlineFollowers } from "./lib/instagramInsights.js";
import { collectSiteStats } from "./lib/siteStats.js";
import { notifyHotProperties } from "./lib/propertyHotAlert.js";
import { runPublishedChannelsAuditTick } from "./lib/publishedChannelsAudit.js";
import { runIntegrationHealthChecks } from "./lib/integrationHealth.js";
import { followUpLimit, isClosingMessage, isFollowUpDue } from "./lib/botFollowUps.js";
import { distillLessons, EMPTY_LESSON } from "./lib/botLessons.js";
import { runBotAudit } from "./ai/botAudit.js";
import { runDealStalePipeline } from "./lib/dealStalePipeline.js";
import { runSilentClientAutoDeactivate } from "./lib/silentClientAutoDeactivate.js";
import { runLostInactiveTrashSweep } from "./lib/lostInactiveTrashSweep.js";
import { analyzeLostConversations, buildWeeklyLostDigest } from "./lib/lostConversations.js";
import { runReactivationCampaignTick } from "./lib/reactivationCampaign.js";
import { sendBotMessageWithMid } from "./messengers/sendBotMessage.js";
import { askCandidatePhone } from "./lib/askCandidatePhone.js";
import { accountTokenById } from "./messengers/accounts.js";
import { processDueComments } from "./messengers/comments.js";
import { pollYouTubeComments } from "./messengers/youtubeComments.js";
import { processDueTelegramComments } from "./messengers/telegramGroupComments.js";
import { asBotChannel, loadBotChannelToggles, type BotChannelToggles } from "./messengers/botChannels.js";
import { loadBotCapabilities } from "./messengers/botCapabilities.js";
import { appendConversationMessages, recoverStuckPendingMessages } from "./messengers/conversation.js";
import { shortAgentReply } from "./ai/leadQualifier.js";
import { withTimeGaps } from "./ai/conversationTime.js";
import type { ChatMessage } from "./ai/client.js";
import { loadMorningNumbers } from "./lib/morningNumbers.js";
import { ingestVoicemails } from "./lib/telephony/voicemailIngest.js";
import { syncWhispers } from "./lib/telephony/whisperSync.js";
import { syncPropertyWhispers } from "./lib/telephony/propertyWhisper.js";
import { pruneWhisperClips } from "./lib/telephony/whisperClips.js";
import { sweepIncomingCallsForLeads } from "./lib/telephony/autoLeadFromCall.js";
import { adoptReferencedVoiceNotes, cleanupPrivateFiles } from "./lib/privateFiles.js";
import { pruneSettingsSnapshots } from "./lib/settingsSnapshots.js";
import { cleanupStalePropertyVideos } from "./lib/propertyVideoCleanup.js";
import { cleanupStaleVideoUploadSessions } from "./lib/videoUploadCleanup.js";
import { cleanupExpiredPropertyDrafts } from "./routes/properties/draftAttach.js";
import { cleanupExpiredOutgoingMedia } from "./lib/outgoingMediaCleanup.js";
import { cleanupTelegramBotApiVolume } from "./lib/telegramBotApiCleanup.js";
import { runDiskCleanup, diskCleanupSummary, isDiskCleanupDryRun } from "./lib/diskCleanup.js";
import { cleanupProcessedMessages } from "./lib/webhookDedupe.js";
import { notifyStaleOwnerQuestions } from "./lib/ownerQuestionAnswer.js";
import { notifyOverdueMaterials, notifyStuckMaterials } from "./lib/propertyPipeline.js";
import { releaseExpiredReservations } from "./lib/dealReservation.js";
import { expireStaleReactivationOffers, runReactivationOfferReminders } from "./lib/reactivationOffers.js";
import { runInactivityCheck } from "./lib/inactivityPenalty.js";
import { runBuyerNoCallAlarmTick, runRefusedHighScoreAlarmTick } from "./lib/buyerNoCallAlarm.js";
import { runPhoneLeadWatchdogTick } from "./lib/phoneLeadWatchdog.js";
import { sweepExpiredDuplicateReviews, runDuplicateFuzzyScanTick, remindDuplicateReviewsNearingExpiry } from "./lib/duplicateReview.js";
import { buildCallInsights } from "./ai/callInsights.js";
import { findStuckConversations } from "./lib/stuckConversations.js";
import { syncMetaAdsQuietly } from "./lib/ads/syncMetaAds.js";
import { runReelsAutoBoostGuarded } from "./lib/ads/reelsAutoBoost.js";
import { watchStaleSync } from "./lib/ads/adReconcile.js";
import { refreshMetaAdsTokenIfDue } from "./lib/ads/metaAdsToken.js";
import { refreshMetaUserTokensIfDue } from "./lib/metaUserTokenRefresh.js";
import { recentMonths, upsertAiExpenses } from "./lib/ads/adExpenseSync.js";
import { alertExpenseOverrun, processRecurringExpenses, upsertSalaryExpenses } from "./lib/financeAutomation.js";
import { formatAdsDigestLine } from "./lib/ads/adsDigest.js";
import { checkAdAccountAlerts, checkAdAlerts, checkAdDisapprovedAlerts } from "./lib/ads/adAlerts.js";
import { autoResolveDuplicateErrors } from "./lib/autoResolveDuplicateErrors.js";
import { backfillInstagramUrls } from "./lib/backfillInstagramUrls.js";
const MAX_REMINDER_HISTORY = 12;

/**
 * РУБИЛЬНИКИ ПЕРЕЧИТЫВАЮТСЯ ПРЯМО ВНУТРИ ПРОХОДА.
 *
 * Проход по напоминаниям — до 200 диалогов, на каждый вызов ИИ до минуты: он живёт
 * минутами, а не мгновение. Раньше рубильники читались один раз на входе, и владелец,
 * выключивший бота посреди прохода (а выключают его как раз тогда, когда бот ведёт
 * себя плохо), ещё долго видел уходящие напоминания.
 *
 * Читать настройки на каждый диалог — N+1 на ровном месте, поэтому короткий кэш:
 * несколько секунд задержки владелец не заметит, а запросов остаётся единицы на
 * проход. Кэш свой на каждый проход (замыкание, а не глобальная переменная): чужие
 * пути — sendBotMessage, вебхуки — обязаны видеть настройку без всякой задержки.
 */
const SWITCHES_CACHE_MS = 5_000;

function botSwitchesReader(): () => Promise<{ toggles: BotChannelToggles; followUps: boolean }> {
  let cache: { at: number; value: { toggles: BotChannelToggles; followUps: boolean } } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < SWITCHES_CACHE_MS) return cache.value;
    const [toggles, capabilities] = await Promise.all([loadBotChannelToggles(), loadBotCapabilities()]);
    cache = { at: Date.now(), value: { toggles, followUps: capabilities.followUps } };
    return cache.value;
  };
}

// Форма реплики переписки описана один раз в @royal-home/shared.
type StoredMessage = ConversationMessage;

/**
 * Три попытки вернуть в разговор клиента, который перестал отвечать.
 *
 * Пришло на смену разовому напоминанию «вы смотрели ссылки?»: оно срабатывало
 * только у тех, кому бот успел прислать объекты, и молчало, если человек пропал
 * на первом же вопросе. Расписание и правила — в lib/botFollowUps.ts.
 *
 * Здесь только исполнение: кому пора, что написать и куда отправить.
 */
export async function sendFollowUps(): Promise<number> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      followUpEnabled: true,
      followUpWindowStart: true,
      followUpWindowEnd: true,
      followUpMaxAttempts: true,
    },
  });
  if (settings?.followUpEnabled === false) return 0;
  // Ползунок «напоминать молчащим» (Настройки → Бот → «Что бот умеет»). Отдельно
  // от followUpEnabled: тот про расписание напоминаний, этот — про саму
  // способность бота писать первым.
  // Рубильники читаются с коротким кэшем и ПЕРЕЧИТЫВАЮТСЯ внутри прохода
  // (см. botSwitchesReader): проход живёт минутами, и выключение бота посреди него
  // обязано подействовать. Дальше по каналу диалога: напоминание — это тоже голос
  // бота, и в выключенном Instagram его быть не должно, даже когда WhatsApp работает.
  const botSwitches = botSwitchesReader();
  const startSwitches = await botSwitches();
  if (!startSwitches.followUps || !startSwitches.toggles.botEnabled) return 0;
  const window = {
    start: settings?.followUpWindowStart ?? "08:00",
    end: settings?.followUpWindowEnd ?? "20:00",
  };
  // Сколько напоминаний слать — настройка, по умолчанию ОДНО (решение владельца
  // 02.08.2026): не ответивший на первое не ответит и на второе, а навязчивость
  // запомнит. Ноль означает «не напоминать вовсе» — тот же смысл, что рубильник.
  const limit = followUpLimit(settings?.followUpMaxAttempts);
  if (limit === 0) return 0;

  const now = new Date();
  // Раньше суток напоминать не о чем, позже — Meta уже не доставит.
  const candidates = await prisma.botConversation.findMany({
    where: {
      // «Нет ДЕЙСТВУЮЩЕЙ паузы», а не «паузы не было никогда»: истёкшая пауза
      // остаётся в поле прошедшей датой (её никто не обнуляет), и прежний фильтр
      // `pausedUntil: null` навсегда исключал из напоминаний любой диалог, где
      // сотрудник хоть раз ответил руками (10-минутная пауза эха) — молча (26.08.2026).
      OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }],
      // Удалённому/архивному клиенту (Корзина) бот не должен писать первым —
      // это трата вызова ИИ на того, кого уже нет в CRM (аудит трат 13.09.2026).
      // clientId=null — диалог ещё не привязан к карточке — не фильтруем.
      AND: [{ OR: [{ clientId: null }, { client: { deletedAt: null } }] }],
      optedOutAt: null,
      followUpsSent: { lt: limit },
      lastMessageAt: {
        lte: new Date(now.getTime() - 60 * 60 * 1000),
        gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    },
    // Старые — первыми: их 24-часовое окно Meta закрывается раньше. Без orderBy при
    // переполнении очереди (>200) БД отдавала произвольные 200, и часть диалогов
    // могла не получить напоминание никогда.
    orderBy: { lastMessageAt: "asc" },
    take: 200,
  });

  let sent = 0;
  for (const conv of candidates) {
    if (!conv.lastMessageAt) continue;
    // Общий рубильник или ползунок «напоминать молчащим» сняли, пока проход шёл, —
    // прекращаем весь проход, а не только этот диалог. Оставшиеся никуда не денутся:
    // очередь строится заново на следующем тике.
    const bot = await botSwitches();
    if (!bot.followUps || !bot.toggles.botEnabled) break;
    // Бот в этом канале выключен — молчим. Диалог при этом остаётся в очереди:
    // канал включат обратно, и напоминание уйдёт, если ещё будет уместно.
    const channel = asBotChannel(conv.channel);
    if (channel && !bot.toggles.channels[channel]) continue;
    if (!isFollowUpDue(conv.id, conv.lastMessageAt, conv.followUpsSent, window, now, limit)) continue;

    const messages = (Array.isArray(conv.messages) ? conv.messages : []) as unknown as StoredMessage[];
    const last = messages[messages.length - 1];
    // Пишем только вслед своему же сообщению: если последним говорил клиент, значит
    // ответить должен был бот, и напоминание «вы не ответили» звучало бы абсурдно.
    if (!last || last.role !== "assistant") continue;

    /**
     * КЛИЕНТ САМ ЗАКРЫЛ РАЗГОВОР БЛАГОДАРНОСТЬЮ — бот ответил последним из
     * вежливости («Пожалуйста! Если появятся вопросы…»), но ждать тут нечего.
     * 18.08.2026: ровно такой разговор («Да все хорошо, спасибо» → напоминание
     * через 18 часов) владелец показал как пример навязчивости. Смотрим на
     * последнее сообщение КЛИЕНТА, а не бота — это оно решает, закрыт разговор
     * или подвис в ожидании ответа.
     */
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg && isClosingMessage(lastUserMsg.content)) continue;

    /**
     * ЧЕЛОВЕК ДОЛЖЕН БЫЛ ХОТЬ РАЗ ОТВЕТИТЬ. Иначе это не напоминание, а рассылка.
     *
     * 01.08.2026 владелец показал переписку, где человек только откликнулся на
     * рекламу и не написал ни слова. Бот поздоровался, задал вопрос, а потом ещё
     * трижды написал сам себе вслед: «какой вариант вам понравился?» (вариантов он
     * не присылал), «какие у вас планы?», «что вы об этом думаете?». Пять сообщений
     * подряд в пустоту — это ровно то, за что Meta ограничивает аккаунт, и ровно
     * то, из-за чего человек жмёт «заблокировать».
     *
     * Отклик на рекламу и приветствие бота разговором не считаются: разговор
     * начинается тогда, когда человек написал нам сам.
     */
    if (!messages.some((m) => m.role === "user")) continue;

    /**
     * Разговор не про жильё — не напоминаем вовсе. Нам пишут по ошибке, ищут
     * знакомого, предлагают сотрудничество. 01.08.2026 бот отправил напоминание
     * «что там с вашим предложением о сотрудничестве?» другому агентству, которое
     * само писало НАМ. Догонять такого человека незачем и неловко.
     */
    const draft = (conv.leadDraft ?? {}) as { intent?: string };
    if (draft.intent === "other" || draft.intent === "job") continue;

    /**
     * ЗАЯВКА ПРИНЯТА — ДАЛЬШЕ РАБОТА АГЕНТА, А НЕ БОТА.
     *
     * 01.08.2026 человек оставил номер, лид ушёл агенту — и через час бот
     * написал ему сам: «ещё ищете участок? отправим варианты». Для клиента это
     * два разных Royal Home, которые не знают друг о друге: один обещал звонок
     * агента, другой продолжает спрашивать то же самое.
     *
     * У агента есть телефон и есть карточка. Догонять клиента параллельно с ним
     * — значит мешать ему и обесценивать его звонок. Отвечать на новые вопросы
     * бот при этом продолжает: запрет касается только инициативы с нашей стороны.
     */
    if (conv.clientId) continue;

    // Аккаунт выключен тумблером (Настройки → Каналы) — первым ему писать нельзя
    // (CHANNEL-NEW-11). До вызова ИИ: платить за текст, который не уйдёт, незачем.
    // Диалог остаётся в очереди: аккаунт включат, и напоминание уйдёт, если ещё уместно.
    if (conv.accountId && (await accountTokenById(conv.accountId, conv.channel)).disabled) continue;

    try {
      const attempt = conv.followUpsSent + 1;
      // Каждый раз другими словами — прошлые напоминания отдаём модели, чтобы она
      // не повторялась: три одинаковых сообщения выглядят как неисправный автомат.
      const reminder = await shortAgentReply(
        // Разрывы во времени модель должна видеть и здесь — особенно здесь:
        // напоминание пишется как раз после паузы, и без пометки бот продолжал
        // разговор, оборвавшийся месяцы назад, с полуслова (ai/conversationTime.ts).
        withTimeGaps(messages.slice(-MAX_REMINDER_HISTORY) as ChatMessage[]),
        `Клиент не отвечает. Это напоминание номер ${attempt} из ${limit}. Напиши ОДНО короткое ` +
          "дружелюбное сообщение на языке клиента: ненавязчиво верни его к разговору, помоги продолжить. " +
          "ОБЯЗАТЕЛЬНО оттолкнись от того, на чём разговор оборвался (последний вопрос, названный район, " +
          "присланный объект) — по сообщению должно быть видно, что ты помнишь этого человека. " +
          "Строго запрещено: давить, торопить, вызывать чувство вины, писать «вы не ответили», повторять " +
          "формулировки предыдущих напоминаний из переписки выше. Если уместно — задай простой уточняющий вопрос.",
        // Имя и собранное по заявке: без них бот писал «Ассалом, чем могу помочь?»,
        // как будто видит человека впервые, хотя вся переписка была у него перед глазами.
        { name: conv.name, draft: conv.leadDraft }
      );
      if (!reminder) continue;

      // Перепроверка перед самой отправкой: между выборкой и этой строкой прошёл вызов
      // ИИ (до минуты на диалог, а очередь — до 200 диалогов), и клиент мог за это время
      // ответить. Без перепроверки напоминание уходило человеку, который только что написал.
      const fresh = await prisma.botConversation.findUnique({
        where: { id: conv.id },
        select: { lastMessageAt: true, pausedUntil: true, followUpsSent: true, optedOutAt: true },
      });
      if (
        !fresh ||
        // Действующая пауза, а не любая когда-либо стоявшая (см. фильтр кандидатов).
        (fresh.pausedUntil && fresh.pausedUntil.getTime() > Date.now()) ||
        fresh.optedOutAt ||
        fresh.followUpsSent !== conv.followUpsSent ||
        fresh.lastMessageAt?.getTime() !== conv.lastMessageAt.getTime()
      ) {
        continue;
      }

      // Рубильник мог перевести владелец, пока шёл вызов ИИ (до минуты на диалог).
      // Канальный и общий проверит сам sendBotMessage, а ползунок «напоминать
      // молчащим» — только мы: до транспорта он не доходит.
      if (!(await botSwitches()).followUps) break;
      // Напоминание уходит маркером ТОГО аккаунта, в котором идёт разговор
      // (messengers/accounts.ts) — иначе клиент второго Instagram получил бы
      // сообщение от первого, будто с ним говорят два разных Royal Home.
      const accountToken = (await accountTokenById(conv.accountId, conv.channel)).token;
      // Не отправлено — и в переписку писать нечего: иначе в истории появилась бы
      // реплика бота, которой клиент никогда не видел.
      const delivery = await sendBotMessageWithMid(conv.channel, conv.subscriberId, reminder, accountToken);
      if (!delivery.sent) continue;
      // Атомарный append вместо записи всего массива: снимок `messages` снят в начале
      // прохода, а между ним и этой строкой прошли вызов ИИ и отправка (десятки секунд).
      //
      // mid обязателен (аудит №4): напоминание шлёт worker, а эхо Meta разбирает
      // api — без mid в истории собственная реплика бота сходила там за ручной
      // ответ сотрудника (пауза бота на 10 минут + вторая копия в переписке).
      await appendConversationMessages(conv.id, [
        { role: "assistant", content: reminder, by: { kind: "bot" }, ...(delivery.mid ? { mid: delivery.mid } : {}) },
      ]);
      await prisma.botConversation.update({
        where: { id: conv.id },
        data: { followUpsSent: { increment: 1 }, reminderSentAt: new Date() },
      });
      sent++;
    } catch (err) {
      reportCronTickError("Напоминание клиенту", err);
    }
  }
  return sent;
}

/** Утренняя сводка директорам: задачи на сегодня, вчерашние лиды и сделки, комиссия месяца. */
export async function sendDirectorDigest(): Promise<number> {
  // Те же числа, что и в утреннем отчёте рабочей сессии, считаются одной
  // функцией — иначе два отчёта про одно и то же утро расходятся. Границы суток
  // и месяца по Душанбе живут там же (lib/morningNumbers.ts).
  const [
    {
      tasksToday,
      leadsYesterday,
      dealsYesterday,
      commissionMonth,
      errorsYesterday,
      incomingYesterday,
      missedYesterday,
      unqualifiedNow,
      firstTouchMedianMin,
      firstTouchSlowCount,
      firstTouchNoneCount,
      sellersWithoutPropertyOver7Days,
      showingSummariesOverdue48h,
      soldElsewhereWeek,
      reactivationSentThisWeek,
      reactivationRepliedThisWeek,
      reviewsYesterday,
      botPausedNoReply24h,
      missedCallsNoCallbackYesterday,
      propertiesWithdrawnSellerRecovered,
      stuckWorkGivenUpYesterday,
      stuckWorkHangingNow,
      groupShareNotDoneCount,
      adsYesterday,
    },
    directors,
  ] = await Promise.all([
    loadMorningNumbers({ ads: true }),
    prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } }),
  ]);

  const body = [
    `Сегодня: ${tasksToday} ${pluralizeRu(tasksToday, ["задача", "задачи", "задач"])} у команды`,
    `Вчера: ${leadsYesterday} ${pluralizeRu(leadsYesterday, ["новый лид", "новых лида", "новых лидов"])}, ${dealsYesterday} ${pluralizeRu(dealsYesterday, ["сделка", "сделки", "сделок"])}`,
    // Телефон в сводке появился 11.08.2026: до этого директор в 08:00 узнавал про
    // лидов, сделки и ошибки — но не про то, что вчера до агентства не дозвонились
    // одиннадцать человек. Строку показываем, только если звонки вчера были: ноль
    // звонков это не новость, а выключенная телефония.
    ...(incomingYesterday > 0
      ? [
          `Звонки вчера: ${incomingYesterday} ${pluralizeRu(incomingYesterday, ["входящий", "входящих", "входящих"])}` +
            (missedYesterday > 0 ? `, из них ${missedYesterday} пропущено` : ", все приняты"),
        ]
      : []),
    /**
     * СКОРОСТЬ ПЕРВОГО КАСАНИЯ (совет экспертов 26.08, пункт 7).
     *
     * Конверсия лида падает в разы после первых пятнадцати минут — а до сих пор
     * ни один экран и ни одно письмо не называли эту цифру вовсе, хотя
     * firstContactAt пишется давно. Строка появляется, только если вчера были
     * лиды: «медиана: —» в тихий день ничего не сообщает, а место занимает.
     */
    ...(firstTouchMedianMin !== null || firstTouchNoneCount > 0
      ? [
          `⏱️ Первое касание вчера: ${
            firstTouchMedianMin !== null ? `медиана ${firstTouchMedianMin} мин` : "ни одного касания"
          }` +
            (firstTouchSlowCount > 0
              ? `, дольше часа ждали ${firstTouchSlowCount} ${pluralizeRu(firstTouchSlowCount, ["лид", "лида", "лидов"])}`
              : "") +
            (firstTouchNoneCount > 0 ? `, без ответа ${firstTouchNoneCount}` : ""),
        ]
      : []),
    `Комиссия за месяц: ${new Intl.NumberFormat("ru-RU").format(commissionMonth)} с.`,
    // Волна 1 «Реклама» (03.10.2026): строка только когда кабинет подключён и вчера были
    // траты (lib/ads/adsDigest.ts) — выключенная реклама не новость.
    ...(adsYesterday ? [formatAdsDigestLine(adsYesterday)] : []),
    // Пачка 9 (11.09.2026): грубый градусник, не замена runSellerNoPropertyAlarmTick
    // (тот алармит директору лично по одному клиенту, от даты встречи) — см.
    // doc-comment у MorningNumbers.sellersWithoutPropertyOver7Days.
    ...(sellersWithoutPropertyOver7Days > 0
      ? [
          `🏚️ ${sellersWithoutPropertyOver7Days} ${pluralizeRu(sellersWithoutPropertyOver7Days, ["продавец", "продавца", "продавцов"])} без объекта дольше недели`,
        ]
      : []),
    ...(unqualifiedNow > 0
      ? [
          `📋 ${unqualifiedNow} ${pluralizeRu(unqualifiedNow, ["разговор ждёт", "разговора ждут", "разговоров ждут"])} разбора оператором`,
        ]
      : []),
    // Пачка 17 (12.09.2026): «бот на паузе и забыли» — см. doc-comment у
    // MorningNumbers.botPausedNoReply24h / lib/botPauseWatch.ts.
    ...(botPausedNoReply24h > 0
      ? [
          `⏸️ ${botPausedNoReply24h} ${pluralizeRu(botPausedNoReply24h, ["диалог", "диалога", "диалогов"])} на паузе бота ждут ответа человека дольше суток`,
        ]
      : []),
    ...(errorsYesterday > 0
      ? [`⚠️ Поймано ${errorsYesterday} ${pluralizeRu(errorsYesterday, ["ошибка", "ошибки", "ошибок"])} системы — детали в Настройках`]
      : []),
    // Пачка 10, 11.09.2026, п.3: «Итог показа» без исхода больше двух суток —
    // прямо на проде их было 5 из 5 незакрытых, узнать об этом можно было
    // только руками зайдя в каждую карточку.
    ...(showingSummariesOverdue48h > 0
      ? [
          `❗ ${showingSummariesOverdue48h} ${pluralizeRu(showingSummariesOverdue48h, ["итог показа", "итога показа", "итогов показа"])} не заполнены больше двух суток`,
        ]
      : []),
    // Пачка 13, 11.09.2026, п.1: динамика «продано мимо агентства» за неделю —
    // каждый случай уже эскалирован в СБ поодиночке (lib/sellerRefusalReview.ts),
    // эта строка только показывает счёт, а не заменяет тревогу.
    ...(soldElsewhereWeek > 0
      ? [
          `🚩 ${soldElsewhereWeek} ${pluralizeRu(soldElsewhereWeek, ["случай", "случая", "случаев"])} «продано мимо агентства» за неделю`,
        ]
      : []),
    // Пачка 12, 11.09.2026: строка появляется только когда за неделю реально
    // что-то отправлялось — тихая неделя (тумблер выключен или пачка пуста)
    // не должна занимать место в сводке.
    ...(reactivationSentThisWeek > 0
      ? [
          `📨 Реактивация за неделю: отправлено ${reactivationSentThisWeek}, ответили ${reactivationRepliedThisWeek}`,
        ]
      : []),
    // Пачка 11 (11.09.2026): ответы на вопрос об отзыве за вчера — только если
    // хоть один ответ был, тишина в тихий день не новость.
    ...(reviewsYesterday > 0
      ? [`⭐ ${reviewsYesterday} ${pluralizeRu(reviewsYesterday, ["отзыв", "отзыва", "отзывов"])} после сделки за вчера`]
      : []),
    // Пачка 18 (12.09.2026): пропущенные без перезвона за вчера, на сейчас — по
    // каждому отдельному звонку уже напоминает/эскалирует отдельный крон каждые
    // 30 минут (lib/telephony/missedCallEscalation.ts), здесь только общий счёт.
    ...(missedCallsNoCallbackYesterday > 0
      ? [
          `📵 ${missedCallsNoCallbackYesterday} ${pluralizeRu(missedCallsNoCallbackYesterday, ["пропущенный", "пропущенных", "пропущенных"])} без перезвона за вчера`,
        ]
      : []),
    // 18.09.2026 (объект #82): объекты, автоматически снятые с продажи из-за
    // «потерянного» продавца, чья карточка уже не «Потерянная» — автоматика
    // назад не поднимает никогда (см. doc-comment у
    // MorningNumbers.propertiesWithdrawnSellerRecovered), строка нужна, чтобы
    // разъезд не лежал незамеченным до случайной находки.
    ...(propertiesWithdrawnSellerRecovered > 0
      ? [
          `🏠↩️ ${propertiesWithdrawnSellerRecovered} ${pluralizeRu(propertiesWithdrawnSellerRecovered, ["объект снят", "объекта снято", "объектов снято"])} из-за «потерянного» продавца, хотя продавец уже не «Потерянный» — проверить возврат в продажу`,
        ]
      : []),
    // 21.09.2026 («Что не доехало», lib/stuckWork.ts): строка только когда есть
    // о чём сказать (владелец, п.3 задания) — сумма сдавшихся за сутки и
    // висящих сейчас заданий фоновой очереди.
    ...(stuckWorkGivenUpYesterday + stuckWorkHangingNow > 0
      ? [
          `🧵 Не доехало: ${stuckWorkGivenUpYesterday} ${pluralizeRu(stuckWorkGivenUpYesterday, ["задание сдалось", "задания сдалось", "заданий сдалось"])} за сутки, ${stuckWorkHangingNow} ${pluralizeRu(stuckWorkHangingNow, ["висит", "висят", "висят"])} сейчас — экран «Что не доехало»`,
        ]
      : []),
    // 28.09.2026 («Раздать по группам Facebook», lib/facebookGroupShare.ts):
    // null — список групп в Настройках пуст, строку не печатаем вовсе (не
    // включённая настройка — не то же самое, что «всё раздано»).
    ...(groupShareNotDoneCount !== null && groupShareNotDoneCount > 0
      ? [
          `📣 ${groupShareNotDoneCount} ${pluralizeRu(groupShareNotDoneCount, ["объект в продаже", "объекта в продаже", "объектов в продаже"])} не раздано ни в одну группу Facebook`,
        ]
      : []),
  ].join("\n");

  await Promise.all(
    directors.map((d) =>
      sendPushToAgent(d.id, { title: "🗂️ Утренняя сводка", body, url: "/", tag: "director-digest" })
    )
  );
  return directors.length;
}

/** Пуш директорам о готовой недельной сводке. Без него сводка тихо лежала бы в
 *  Настройках, и о ней вспоминали бы раз в квартал — а предложения из неё
 *  действуют только после того, как владелец их отметил. */
async function notifyDirectorsAboutLostDigest(lostCount: number, proposals: number): Promise<void> {
  const directors = await prisma.agent.findMany({
    where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
    select: { id: true },
  });
  const body =
    `${lostCount} ${pluralizeRu(lostCount, ["переписка оборвалась", "переписки оборвались", "переписок оборвались"])} без заявки. ` +
    (proposals > 0
      ? `Бот предлагает ${proposals} ${pluralizeRu(proposals, ["правило", "правила", "правил"])} — отметьте дельное.`
      : "Предложений нет, но видно, на каком шаге теряются люди.");
  await Promise.all(
    directors.map((d) =>
      sendPushToAgent(d.id, {
        title: "🗂️ Куда уходят клиенты",
        body,
        url: "/settings?tab=bot",
        tag: "lost-clients-digest",
        // Сводка остаётся в Настройках независимо от пуша (решение владельца
        // 24.08.2026) — тот же "oversight", что и у разбора проблемных мест.
        kind: "oversight",
      })
    )
  );
}

export function startCronJobs() {
  // Explicit opt-in only; produces current-month drafts, never sends SMS.
  scheduleTracked("owner-report-monthly-preview", "20 8 * * *", async () => {
    const { prepareMonthlyOwnerReportPreviews } = await import("./lib/ownerReport/monthlyPreview.js");
    await prepareMonthlyOwnerReportPreviews();
  }, { timezone: "Asia/Dushanbe" });
  /** Вечерняя сводка агенту — 18:00 по Душанбе, задачи и встречи на завтра одним
   *  push. Вечером накануне, а не утром в день встречи: агент успевает спланировать. */
  scheduleTracked(
    "tomorrow-digest",
    "0 18 * * *",
    async () => {
      try {
        const sent = await sendTomorrowDigest();
        if (sent) console.log(`[cron] Сводка на завтра отправлена агентам: ${sent}`);
      } catch (err) {
        reportCronTickError("Ошибка сводки на завтра", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Свободные ролики в соцсети (12.10.2026): раз в минуту запускает ролики, чьё время по расписанию пришло,
   *  и снимает оборванные публикации. Сама публикация идёт заданием очереди (jobs/socialVideoPublish.ts). */
  scheduleTracked("social-video-schedule", "* * * * *", async () => {
    try {
      const { started, recovered } = await runSocialVideoScheduleTick();
      if (started || recovered) console.log(`[cron] Свободные ролики: запущено ${started}, оборвавшихся снято ${recovered}`);
    } catch (err) {
      reportCronTickError("Ошибка расписания свободных роликов", err);
    }
  });

  /** Напоминания перед встречей — каждые 5 минут. Тик частый, но запрос узкий: окно
   *  по индексированному nextActionDate. Ступени: показ — за 2 часа и за 40 минут
   *  (пробки), прочие задачи — за час. Здесь же контроль непроведённых показов:
   *  тот же тик, отдельный запрос, руководству уходит один push на показ. */
  /** Сообщения клиентов, застрявшие в буфере дебаунса из-за перезапуска API
   *  посреди ожидания (см. recoverStuckPendingMessages в messengers/conversation.ts,
   *  найдено 19.08.2026 — владелец пожаловался на пустую переписку у диалога,
   *  который в списке выглядел живым). Каждые 5 минут, тик дешёвый (пустая
   *  выборка почти всегда). */
  scheduleTracked("stuck-pending-messages", "*/5 * * * *", async () => {
    try {
      const recovered = await recoverStuckPendingMessages();
      if (recovered) console.log(`[cron] Застрявших сообщений клиентов восстановлено: ${recovered}`);
    } catch (err) {
      reportCronTickError("Ошибка восстановления застрявших сообщений", err);
    }
  });

  /**
   * ГВАРД ОТ НАЛОЖЕНИЯ ТИКОВ (найдено 20.08.2026 — живой инцидент: агент получил
   * один и тот же пуш «Карточка не заполнена» 10 раз подряд за 45 минут).
   *
   * Семь задач подряд в одном тике, и `notifyStaleOwnerQuestions` внутри — до 50
   * последовательных вызовов ИИ плюс сетевая отправка на каждый. При заметном
   * бэклоге проход легко перевешивает 5 минут, а node-cron НЕ ждёт окончания
   * предыдущего тика перед следующим. Пока проход N ещё не дошёл до записи
   * «уже напомнили» по конкретной карточке, тик N+1 успевает прочитать то же
   * старое состояние и напомнить туда же второй раз — и так на каждом наложении.
   * Тот же приём, что уже стоит у соседних тяжёлых тиков ниже
   * (isShowingConfirmRunning, isHealthAutomationRunning и т.д.) — здесь его
   * забыли завести вместе с блоком.
   */
  let isReminderBatchRunning = false;
  scheduleTracked("meeting-reminders", "*/5 * * * *", async () => {
    if (isReminderBatchRunning) return;
    isReminderBatchRunning = true;
    try {
      try {
        const sent = await sendHourBeforeReminders();
        if (sent) console.log(`[cron] Напоминаний о встречах: ${sent}`);
      } catch (err) {
        reportCronTickError("Ошибка напоминаний о встречах", err);
      }
      try {
        const notified = await notifyMissedShowings();
        if (notified) console.log(`[cron] Непроведённых показов, о которых сообщили: ${notified}`);
      } catch (err) {
        reportCronTickError("Ошибка контроля показов", err);
      }
      try {
        const notified = await notifyOverdueTasks();
        if (notified) console.log(`[cron] Просроченных встреч/задач, о которых сообщили: ${notified}`);
      } catch (err) {
        reportCronTickError("Ошибка контроля просроченных встреч/задач", err);
      }
      try {
        const { reminded, escalated } = await remindIncompleteCards();
        if (reminded || escalated) console.log(`[cron] Незаполненные карточки: ${reminded} агентам, ${escalated} руководству`);
      } catch (err) {
        reportCronTickError("Ошибка контроля карточек", err);
      }
      /* Заведение и контроль обязательных окон итогов убраны 14.09.2026 вместе с самим
         механизмом (решение владельца). Опрос-звонок после показа (lib/showingSurvey.ts,
         антифрод) заменён 17.09.2026 на робозвонок «показ -> тишина» (lib/postShowingCall.ts,
         свой тик ниже) -- решение владельца: два механизма звонили бы одним и тем же
         покупателям. */
      try {
        const notified = await notifyStaleOwnerQuestions();
        if (notified) console.log(`[cron] Автоответов на просроченные «уточню у собственника»: ${notified}`);
      } catch (err) {
        reportCronTickError("Ошибка автоответа на просроченные вопросы собственнику", err);
      }
    } finally {
      isReminderBatchRunning = false;
    }
  });

  // Звонки робота живым голосом (опрос после показа, проверка продавца,
  // приглашение кандидата) — НЕ здесь: они обязаны жить в одном процессе с
  // мостом голоса, см. lib/telephony/liveVoiceScenarioTicks.ts (28.09.2026).

  /** Подтверждение показа обеими сторонами — тот же интервал в 5 минут, но
   *  отдельным тиком с гвардом: в отличие от push, здесь на каждый показ идёт
   *  сетевая отправка в мессенджер, и проход может перевалить за 5 минут.
   *  Без гварда следующий тик взял бы те же показы (confirmAskedAt ставится
   *  только ПОСЛЕ доставки) и клиент получил бы два одинаковых сообщения. */
  let isShowingConfirmRunning = false;
  scheduleTracked("showing-confirmations", "*/5 * * * *", async () => {
    if (isShowingConfirmRunning) return;
    isShowingConfirmRunning = true;
    try {
      const asked = await sendShowingConfirmationRequests();
      if (asked) console.log(`[cron] Просьб подтвердить показ отправлено клиентам: ${asked}`);
    } catch (err) {
      reportCronTickError("Ошибка просьб подтвердить показ", err);
    }
    try {
      const nudged = await notifyUnconfirmedShowings();
      if (nudged) console.log(`[cron] Показов без подтверждения, о которых сказали агенту: ${nudged}`);
    } catch (err) {
      reportCronTickError("Ошибка сигналов о неподтверждённых показах", err);
    } finally {
      isShowingConfirmRunning = false;
    }
  });

  /**
   * СООБЩЕНИЯ АВТООТВЕТЧИКА — каждые 2 минуты. Клиент, наговоривший сообщение
   * ночью, ждёт звонка утром — но клиент, наговоривший его в обед (оператор
   * отошёл), ждёт СЕЙЧАС, поэтому чаще, чем «раз в полчаса». Проход дешёвый:
   * один листинг каталога, а новые файлы — редкость.
   */
  let isVoicemailRunning = false;
  scheduleTracked("voicemail-ingest", "*/2 * * * *", async () => {
    if (isVoicemailRunning) return;
    isVoicemailRunning = true;
    try {
      const processed = await ingestVoicemails();
      if (processed) console.log(`[cron] Сообщений автоответчика обработано: ${processed}`);
    } catch (err) {
      reportCronTickError("Ошибка обработки автоответчика", err);
    } finally {
      isVoicemailRunning = false;
    }
  });

  /**
   * ПОДСКАЗКИ АГЕНТУ О ЗВОНЯЩЕМ — каждые 5 минут.
   *
   * Озвучка идёт ЗАРАНЕЕ и никогда на пути звонка: в момент разговора файл обязан уже
   * лежать на станции (lib/telephony/whisperSync.ts). Проход дешёвый — сравнение
   * отпечатков карточек с озвученным; синтез речи зовётся только на расхождениях,
   * а их в обычный день единицы: завели клиента, сменили вид, передали другому агенту.
   *
   * Пять минут — компромисс: новый клиент получает голос почти сразу, а станция
   * забирает файлы своим заходом (тоже раз в пять минут), то есть до первого звонка
   * успевает и то, и другое.
   */
  let isWhisperSyncRunning = false;
  scheduleTracked("whisper-sync", "*/5 * * * *", async () => {
    if (isWhisperSyncRunning) return;
    isWhisperSyncRunning = true;
    try {
      const { rendered, removed, failed } = await syncWhispers();
      if (rendered || removed || failed) {
        console.log(`[cron] Подсказки агенту: озвучено ${rendered}, убрано ${removed}, отказов ${failed}`);
      }
      // Подсказка по приметам объекта — для перевода звонка агенту объекта
      // (24.09.2026, lib/telephony/propertyWhisper.ts). После клиентских: у них
      // общая суточная квота синтеза, и подсказки о клиентах важнее.
      const byProperty = await syncPropertyWhispers();
      if (byProperty.rendered || byProperty.removed || byProperty.failed) {
        console.log(
          `[cron] Подсказки по объектам: озвучено ${byProperty.rendered}, убрано ${byProperty.removed}, отказов ${byProperty.failed}`
        );
      }
      // Кусочки озвучки живут дольше самих подсказок (их переиспользуют другие
      // клиенты с тем же именем), но не вечно — см. whisperClips.ts.
      const prunedClips = await pruneWhisperClips();
      if (prunedClips) console.log(`[cron] Кусочков озвучки убрано: ${prunedClips}`);
    } catch (err) {
      reportCronTickError("Ошибка озвучки подсказок", err);
    } finally {
      isWhisperSyncRunning = false;
    }
  });

  // Догоняющая расшифровка разговоров с 27.08.2026 живёт в очереди заданий
  // (jobs/transcriptionRetry.ts, тик background-jobs ниже) — отдельный тик
  // и его in-memory очередь удалены вместе с костылём досева после рестарта.

  /**
   * ЛИДЫ ИЗ ВХОДЯЩИХ ЗВОНКОВ — каждые 10 минут (18.08.2026).
   *
   * Обычный путь — конец конвейера расшифровки (callRecordings.ts): карточка
   * появляется через минуту после разговора. Этот проход добирает то, до чего
   * конвейер не дошёл вовсе: записи на станции не оказалось, поставщик отказал на
   * всех кусках, процесс перезапустился посреди обработки. Без него такой звонок
   * молча оставался бы строкой в журнале — при том что человек звонил и говорил.
   *
   * Часами приёма НЕ гейтится: разговор уже состоялся, это факт, а не сигнал.
   * Повторов не боится — замок `autoLeadAt` делает разбор однократным.
   */
  let isIncomingLeadSweepRunning = false;
  scheduleTracked("incoming-call-lead-sweep", "*/10 * * * *", async () => {
    if (isIncomingLeadSweepRunning) return;
    isIncomingLeadSweepRunning = true;
    try {
      const handled = await sweepIncomingCallsForLeads();
      if (handled > 0) console.log(`[cron] Входящих звонков разобрано автоматически: ${handled}`);
    } catch (err) {
      reportCronTickError("Ошибка автоматического разбора входящих", err);
    } finally {
      isIncomingLeadSweepRunning = false;
    }
  });

  // «stuck-call-stubs» и «callback-connect» живут в процессе api рядом с картой
  // живых звонков (lib/telephony/callMemoryTicks.ts, E2/E3 глубокой проверки
  // 02.10.2026): здесь, в worker, эта карта всегда пуста.

  /**
   * СТОРОЖ «ВХОДЯЩИЕ НЕ ДОХОДЯТ» — раз в час (разбор 19.09.2026).
   *
   * Все проверки выше сторожат ОТДЕЛЬНЫЙ звонок: зависшую заготовку, очередь,
   * пропущенный перезвон. Ни одна не замечает, что звонков не стало вовсе, —
   * и именно так месяц прошёл незамеченным. Тик дешёвый (два-три count) и
   * молчит вне часов алармов и без настроенной телефонии.
   */
  let isIncomingSilenceCheckRunning = false;
  scheduleTracked("incoming-calls-silence", "7 * * * *", async () => {
    if (isIncomingSilenceCheckRunning) return;
    isIncomingSilenceCheckRunning = true;
    try {
      const { alerted, symptoms } = await runIncomingCallsSilenceTick();
      if (alerted > 0) console.log(`[cron] Тревога по входящим звонкам: ${symptoms.join(", ")}`);
    } catch (err) {
      reportCronTickError("Ошибка сторожа входящих звонков", err);
    } finally {
      isIncomingSilenceCheckRunning = false;
    }
  });

  /**
   * ФОТО-ПОСТЫ ДЛЯ ОБЪЕКТОВ БЕЗ РОЛИКА — раз в час (28.09.2026, agent-brief.md,
   * решение владельца 26.09.2026). Расставляет кандидатов по слотам публикации
   * (lib/photoPosts.ts::schedulePhotoPostsTick) — сама публикация уходит фоновым
   * заданием photo-post-publish, тик только выдаёт слот и ставит задание в
   * очередь. Молчит, когда Settings.photoPostsEnabled выключен (по умолчанию).
   */
  let isPhotoPostsTickRunning = false;
  scheduleTracked(
    "photo-posts-tick",
    "7 * * * *",
    async () => {
      if (isPhotoPostsTickRunning) return;
      isPhotoPostsTickRunning = true;
      try {
        const { scheduled } = await schedulePhotoPostsTick();
        if (scheduled > 0) console.log(`[cron] Фото-посты: поставлено в очередь ${scheduled}`);
      } catch (err) {
        reportCronTickError("Ошибка расстановки фото-постов", err);
      } finally {
        isPhotoPostsTickRunning = false;
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ПОВТОРНЫЕ ПОКАЗЫ ОБЪЕКТОВ — раз в час (28.09.2026, agent-brief.md
   * reposts-digests, решение владельца 26.09.2026). Расставляет кандидатов по
   * слотам публикации (lib/socialReposts.ts::scheduleRepostsTick) — сама
   * публикация уходит фоновым заданием social-repost-publish. Молчит, когда
   * Settings.repostsEnabled выключен (по умолчанию).
   */
  let isSocialRepostsTickRunning = false;
  scheduleTracked(
    "social-reposts-tick",
    "12 * * * *",
    async () => {
      if (isSocialRepostsTickRunning) return;
      isSocialRepostsTickRunning = true;
      try {
        const { scheduled } = await scheduleRepostsTick();
        if (scheduled > 0) console.log(`[cron] Повторные показы: поставлено в очередь ${scheduled}`);
      } catch (err) {
        reportCronTickError("Ошибка расстановки повторных показов", err);
      } finally {
        isSocialRepostsTickRunning = false;
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ПОДБОРКИ ОБЪЕКТОВ — тик каждые 15 минут (28.09.2026, agent-brief.md
   * reposts-digests). Сама функция решает, наступил ли день+час
   * (Settings.digestWeekday/digestHourDushanbe) и не запускали ли уже сегодня
   * (Settings.digestLastRunAt) — тот же приём, что у daily-stories ниже.
   * Молчит, когда Settings.digestsEnabled выключен (по умолчанию).
   */
  scheduleTracked(
    "social-digests-tick",
    "*/15 * * * *",
    async () => {
      try {
        const result = await runSocialDigestsTick();
        if (result.ran) {
          console.log(
            `[cron] Подборка объектов: вид ${result.kind ?? "?"}, объектов ${result.candidateCount ?? 0}, ` +
              `опубликовано ${result.published ?? 0}, не удалось ${result.failed ?? 0}${result.reason ? `, причина: ${result.reason}` : ""}`
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка еженедельной подборки объектов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * СВЕРКА ОЧЕРЕДИ ВХОДЯЩИХ СО СТАТУСОМ АГЕНТОВ — каждые 5 минут (владелец
   * 19.08.2026). syncAgentQueuePresence уже вызывается сразу при отключении,
   * заморозке и смене номера (routes/agents.ts) — этот обход только страхует
   * тот момент, когда AMI была недоступна и пометка не легла.
   */
  let isQueuePresenceSyncRunning = false;
  scheduleTracked("operator-queue-presence", "*/5 * * * *", async () => {
    if (isQueuePresenceSyncRunning) return;
    isQueuePresenceSyncRunning = true;
    try {
      await reconcileOperatorQueuePresence();
    } catch (err) {
      reportCronTickError("Сверка очереди со статусом агентов", err);
    } finally {
      isQueuePresenceSyncRunning = false;
    }
  });

  /**
   * МОБИЛЬНОЕ ПЛЕЧО АГЕНТОВ НА СТАНЦИИ — каждые 15 минут (04.09.2026).
   * syncAgentMobileFallback уже вызывается сразу при заведении сотрудника и
   * смене номера/телефона (routes/agents.ts) — этот обход подстраховывает
   * момент, когда AMI была недоступна, ИЛИ кто-то руками (Apply Config в
   * FreePBX по этому расширению) стёр мобильное плечо на станции.
   */
  let isMobileFallbackSyncRunning = false;
  scheduleTracked("agent-mobile-fallback", "*/15 * * * *", async () => {
    if (isMobileFallbackSyncRunning) return;
    isMobileFallbackSyncRunning = true;
    try {
      await reconcileAgentMobileFallback();
      /**
       * И СРАЗУ — ОЧЕРЕДЬ ВХОДЯЩИХ (19.09.2026, жалоба владельца про новых
       * сотрудников Сурайё и Комрона и просьба «чтобы всегда, даже когда новых
       * добавляем, тоже всё сработало в будущем»).
       *
       * Тем же тиком и той же связью с AMI, что и мобильное плечо: это два
       * вопроса про одно и то же — «дойдёт ли до человека звонок», — и
       * разносить их по разным расписаниям значило бы дважды будить станцию
       * ради одного ответа. Обход обязателен, а не желателен: участник очереди
       * добавляется динамически и не переживает «Apply Config» в FreePBX —
       * ровно как мобильное плечо (см. agentIncomingReadiness.ts).
       */
      await reconcileIncomingQueue();
    } catch (err) {
      reportCronTickError("Сверка мобильного плеча агентов", err);
    } finally {
      isMobileFallbackSyncRunning = false;
    }
  });

  /**
   * СВОДНАЯ ПРОВЕРКА ТЕЛЕФОНИИ — каждые 15 минут (разбор 20.09.2026, см. заголовок
   * lib/telephony/stationHealth.ts). Три поломки в один день (мёртвая статическая
   * трубка в очереди приёма, транк подставлял чужой CID, таймаут вебсокета 0,1 с)
   * не поймала ни одна существующая проверка — узнали от владельца, а не от
   * системы. Этот тик закрывает то, что не видят узкие сторожа рядом: жив ли
   * ARI/AMI, загружен ли диалплан РЕАЛЬНО (не только в файле), доступен ли хоть
   * один участник очереди прямо сейчас, на месте ли права AMI. Тревогу поднимает
   * не с первого отказа, а только когда он подтвердился на следующем проходе
   * подряд — тот же приём, что уже в этом файле у соседних телефонных тиков,
   * потому что связь идёт через туннель и штатно моргает на десятки секунд.
   */
  let isStationHealthCheckRunning = false;
  scheduleTracked("telephony-station-health", "*/15 * * * *", async () => {
    if (isStationHealthCheckRunning) return;
    isStationHealthCheckRunning = true;
    try {
      const { confirmedBroken } = await runStationHealthTick();
      if (confirmedBroken.length > 0) {
        console.log(`[cron] Телефония: подтверждённые поломки — ${confirmedBroken.join(", ")}`);
      }
    } catch (err) {
      reportCronTickError("Сводная проверка телефонии", err);
    } finally {
      isStationHealthCheckRunning = false;
    }
  });

  /**
   * ТРАФИК ПЛАТНОГО КАНАЛА СТАНЦИИ — раз в час (08.10.2026). Станция ходит к CRM
   * через реальный адрес, оператор берёт ≈100 сомони за 10 ГБ; тик читает учёт
   * со станции и предупреждает директора при 70 и 90 % месячного лимита
   * (lib/telephony/stationTraffic.ts). Станция или адрес не заданы — молчит.
   */
  let isStationTrafficRunning = false;
  scheduleTracked("telephony-station-traffic", "17 * * * *", async () => {
    if (isStationTrafficRunning) return;
    isStationTrafficRunning = true;
    try {
      const { alertedLevel } = await runStationTrafficTick();
      if (alertedLevel) console.log(`[cron] Трафик станции: порог ${alertedLevel} % месячного лимита`);
    } catch (err) {
      reportCronTickError("Учёт трафика станции", err);
    } finally {
      isStationTrafficRunning = false;
    }
  });

  /**
   * АВТОМАТИКА МОНИТОРИНГА ЗДОРОВЬЯ СИСТЕМЫ — каждые 30 минут (18.08.2026,
   * решение владельца: раньше обе проблемы ждали, пока кто-то зайдёт на /health
   * и нажмёт кнопку руками).
   *
   * Два действия за проход: (1) повторяет диалоги, зависшие без ответа бота
   * (та же логика, что у ручной кнопки — lib/stuckConversations.ts), и
   * (2) схлопывает дубли одинаковых неразобранных ошибок, оставляя открытой
   * только самую свежую копию (lib/autoResolveDuplicateErrors.ts). Раз в 30
   * минут — тот же порядок величины, что и okно ретраев ИИ (~13ч, см.
   * ai/aiRetryQueue.ts), но не реже: клиент не должен ждать до следующего
   * собственного сообщения, если фоновая очередь уже сдалась.
   */
  /**
   * РАСХОДЫ НА РЕКЛАМУ — каждые 15 минут, с перезаливом последних семи дней.
   *
   * Раньше было раз в час (03.10.2026 владелец: «новая реклама должна быть видна
   * сразу»). Чаще четверти часа спрашивать нечего: цифры кабинета обновляются с
   * задержкой в десятки минут, а лимиты Graph API не бесконечны. Перезалив
   * недели — не расточительство, а требование самой Meta: она правит расход
   * задним числом (см. lib/ads/syncMetaAds.ts). Наложение прогонов закрывает
   * флаг isAdsSyncRunning ниже, а между процессами и путями запуска (фон при
   * открытии раздела, кнопка в Настройках) — advisory-замок самой синхронизации.
   *
   * Пока кабинет не подключён (нет маркера или выключен рубильник), задача молча
   * ничего не делает и в журнал ошибок не пишет.
   */
  let isAdsSyncRunning = false;
  scheduleTracked("meta-ads-sync", "*/15 * * * *", async () => {
    if (isAdsSyncRunning) return;
    isAdsSyncRunning = true;
    try {
      const result = await syncMetaAdsQuietly();
      if (result) {
        console.log(
          `[cron] Реклама: объявлений ${result.ads} (привязано ${result.matched}, без объекта ${result.unmatched}, ` +
            `неполных ${result.incomplete}), строк расхода ${result.spendRows}, карточек починено ${result.healed}, ` +
            `проблем сверки ${result.issues}`
        );
      }
    } catch (err) {
      reportCronTickError("Ошибка синхронизации рекламы", err);
    } finally {
      isAdsSyncRunning = false;
    }
  });

  /**
   * СТОРОЖ «СИНХРОНИЗАЦИЯ РЕКЛАМЫ ДАВНО НЕ ПРОХОДИЛА» — раз в час, независимо от самой
   * синхронизации (ревью 03.10.2026): сверка живёт ПОСЛЕ удачной синхронизации и при
   * сломанной не срабатывала вовсе. Громкая запись в журнал — раз в сутки (ключ дедупа).
   */
  scheduleTracked("meta-ads-stale-watch", "10 * * * *", async () => {
    try {
      await watchStaleSync();
    } catch (err) {
      reportCronTickError("Ошибка сторожа давности синхронизации рекламы", err);
    }
  });

  /**
   * Автопродвижение роликов (lib/ads/reelsAutoBoost.ts): новый Reels объекта → объявление
   * в постоянной кампании Meta, лишнее на паузу. Выключено в Настройках по умолчанию —
   * тогда тик ничего не читает и не пишет; в пробном режиме в Meta не ходит.
   */
  scheduleTracked("reels-autoboost", "*/30 * * * *", async () => {
    try {
      await runReelsAutoBoostGuarded();
    } catch (err) {
      reportCronTickError("Ошибка автопродвижения роликов", err);
    }
  });

  let isHealthAutomationRunning = false;
  scheduleTracked("health-automation", "*/30 * * * *", async () => {
    if (isHealthAutomationRunning) return;
    isHealthAutomationRunning = true;
    try {
      const stuck = await findStuckConversations();
      if (stuck.length > 0) {
        // Не отвечаем прямо здесь (аудит №4, 27.08): проход по 200 диалогам живёт
        // минутами, и всё это время его мог обгонять другой исполнитель — задание
        // очереди или кнопка «Повторить зависшим». Клиент получал два разных
        // ответа на одно сообщение. Теперь единственный исполнитель — очередь,
        // а она дедуплицирует задания по диалогу.
        await Promise.all(
          stuck.map((row) =>
            enqueueBackgroundJob({
              type: "ai-reply-retry",
              payload: { conversationId: row.id },
              dedupeKey: `ai-reply-retry:${row.id}`,
              maxAttempts: AI_REPLY_RETRY_MAX_ATTEMPTS,
            })
          )
        );
        console.log(`[cron] Здоровье системы: зависших диалогов ${stuck.length} — поставлены в очередь ответов`);
      }
      const collapsed = await autoResolveDuplicateErrors();
      if (collapsed > 0) console.log(`[cron] Здоровье системы: схлопнуто дублей ошибок ${collapsed}`);
    } catch (err) {
      reportCronTickError("Ошибка автоматики здоровья системы", err);
    } finally {
      isHealthAutomationRunning = false;
    }
  });

  /** Утренний дайджест директору — 08:00 по Душанбе. */
  scheduleTracked(
    "morning-report",
    "0 8 * * *",
    async () => {
      try {
        const sent = await sendDirectorDigest();
        console.log(`[cron] Утренний дайджест отправлен директорам: ${sent}`);
      } catch (err) {
        reportCronTickError("Ошибка дайджеста", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );
  /** Ночная уборка ТЕХНИЧЕСКИХ журналов — 03:00 по Душанбе. Сознательно
   *  консервативная: трогает только AiLog (>90 дней) и ErrorLog (>90 дней).
   *  Бизнес-данные (клиенты, объекты, сделки, переписка, AuditLog) НЕ удаляются
   *  никогда — журнал действий обязан жить вечно. */
  scheduleTracked(
    "log-cleanup",
    "0 3 * * *",
    async () => {
      try {
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        await cleanupBotTurnTraces().catch(() => console.warn("[bot-trace] cleanup failed"));
        const [ai, errors] = await prisma.$transaction([
          prisma.aiLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
          prisma.errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
        ]);
        if (ai.count || errors.count) {
          console.log(`[cron] Уборка журналов: AiLog -${ai.count}, ErrorLog -${errors.count}`);
        }
        // Журнал показов объектов — свой срок, ПОЛГОДА, и он длиннее ста дней
        // намеренно. По нему решается, кому достанется лид («бот показывал этому
        // клиенту вот эту квартиру»), а окно этого правила настраивается в
        // Настройках и может быть выставлено на месяцы. Уборка обязана переживать
        // самое длинное разумное окно, иначе правило начнёт промахиваться молча.
        const exposureCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
        const exposures = await prisma.propertyExposure.deleteMany({
          where: { sentAt: { lt: exposureCutoff } },
        });
        if (exposures.count) console.log(`[cron] Уборка журнала показов: -${exposures.count}`);

        // Маркеры действий из шторки уведомлений живут минуты. Держим их сутки
        // после истечения — этого хватает, чтобы разобраться, почему кнопка у
        // агента не сработала, — и удаляем: строка отработавшего маркера не
        // нужна ни для чего, а копится она на каждый выданный лид.
        const tokenCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const tokens = await prisma.pushActionToken.deleteMany({
          where: { expiresAt: { lt: tokenCutoff } },
        });
        if (tokens.count) console.log(`[cron] Уборка маркеров действий: -${tokens.count}`);

        // Лента уведомлений (колокольчик): запись на КАЖДЫЙ push каждому агенту,
        // чистки не было нигде — таблица росла вечно (аудит 26.08.2026). Девяносто
        // дней — тот же срок, что у журналов выше: старое уведомление никто не
        // открывает, история событий живёт в AuditLog и хронологиях, не здесь.
        const notifications = await prisma.notification.deleteMany({
          where: { createdAt: { lt: cutoff } },
        });
        if (notifications.count) console.log(`[cron] Уборка ленты уведомлений: -${notifications.count}`);

        // Разобранные очереди-подтверждения (жалоба владельца 15.09.2026: мусор,
        // который директор/админ видят, но убрать могут только по одному —
        // «Разобрать все» решает видимость, чистка — накопление). Тот же срок,
        // что у AiLog/ErrorLog выше; НЕРАЗОБРАННЫЕ записи не трогаем никогда —
        // это тот же принцип, что и у ErrorLog/BotAuditFinding в этом задании.
        const siteNotifications = await prisma.siteEditNotification.deleteMany({
          where: { resolvedAt: { not: null, lt: cutoff } },
        });
        if (siteNotifications.count) console.log(`[cron] Уборка изменений с сайта: -${siteNotifications.count}`);

        const botAuditFindings = await prisma.botAuditFinding.deleteMany({
          where: { resolvedAt: { not: null, lt: cutoff } },
        });
        if (botAuditFindings.count) console.log(`[cron] Уборка находок аудита диалогов: -${botAuditFindings.count}`);

        // PendingDirectorAlert хранит "processedAt" по смыслу заявки, но поле в
        // схеме называется sentAt (см. prisma/schema.prisma) — не выдумываем
        // отдельное имя, чистим по нему.
        const directorAlerts = await prisma.pendingDirectorAlert.deleteMany({
          where: { sentAt: { not: null, lt: cutoff } },
        });
        if (directorAlerts.count) console.log(`[cron] Уборка алармов директору: -${directorAlerts.count}`);
        // ЭКРАН «ОБУЧЕНИЕ ИИ» (14.09.2026, жалоба владельца: бесконечный список,
        // копится мусор). Срок жизни неразобранного — 30 дней, решение владельца.
        //
        // ВАЖНО: удаляется только НЕРАЗОБРАННОЕ СЫРЬЁ, а не рабочее содержимое
        // промта. Готовые правила (BotLesson.lesson — не null и не EMPTY_LESSON,
        // см. lib/botLessons.ts) и StyleExample (примеры манеры) не трогаем
        // ВООБЩЕ — задание прямо это требует, это не мусор, а промт бота.
        // Признак «разобрано» — поле `lesson`: null значит случай ещё не дошёл до
        // ночного разбора, EMPTY_LESSON («—») значит разбор прошёл и правила не
        // вывел. Оба состояния — сырьё, которое не стало правилом.
        const learningCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const staleLessons = await prisma.botLesson.deleteMany({
          where: {
            investigationOnly: false,
            OR: [{ lesson: null }, { lesson: EMPTY_LESSON }],
            createdAt: { lt: learningCutoff },
          },
        });
        if (staleLessons.count) console.log(`[cron] Уборка неразобранных случаев обучения: -${staleLessons.count}`);

        const staleLostConversations = await prisma.lostConversation.deleteMany({
          where: { createdAt: { lt: learningCutoff } },
        });
        if (staleLostConversations.count) {
          console.log(`[cron] Уборка старых разборов «куда уходят клиенты»: -${staleLostConversations.count}`);
        }

        // digestId у BotLesson (SetNull) переживёт удаление сводки — предложение,
        // которое владелец уже включил, работающим правилом и останется.
        const staleLostDigests = await prisma.lostClientDigest.deleteMany({
          where: { periodEnd: { lt: learningCutoff } },
        });
        if (staleLostDigests.count) {
          console.log(`[cron] Уборка старых недельных сводок «куда уходят клиенты»: -${staleLostDigests.count}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка уборки журналов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Статусы клиентов, которые зависят от ВРЕМЕНИ, а не от события: остывание
   *  после недели тишины, «не отвечает» после трёх недозвонов, архив после двух
   *  месяцев молчания. Событийные переходы (поговорили, назначили показ, закрыли
   *  сделку) пересчитываются сразу в момент события — ждать ночи там незачем.
   *  04:40 — после ночного разбора звонков и до утренних сводок, чтобы
   *  руководитель с утра видел уже актуальные статусы. */
  scheduleTracked(
    "client-auto-statuses",
    "40 4 * * *",
    async () => {
      try {
        const { checked, changed } = await refreshStatusesByTime();
        if (changed) console.log(`[cron] Автостатусы: проверено ${checked}, изменено ${changed}`);
      } catch (err) {
        reportCronTickError("Ошибка автостатусов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Сверка статусов ОБЪЕКТОВ со сделками (см. lib/propertyAutoStatus.ts). В
   *  отличие от клиентских статусов, здесь ничего не зависит от времени: это
   *  ремонт рассинхронизации — объект в резерве без сделки, проданный объект,
   *  оставшийся в продаже. Отдельным тиком через десять минут после клиентского,
   *  а не вместе с ним: общий try/catch означал бы, что сбой одной сверки
   *  отменяет вторую. */
  scheduleTracked(
    "property-auto-statuses",
    "50 4 * * *",
    async () => {
      try {
        const { checked, changed } = await refreshPropertyStatusesByTime();
        if (changed) console.log(`[cron] Автостатусы объектов: проверено ${checked}, изменено ${changed}`);
      } catch (err) {
        reportCronTickError("Ошибка автостатусов объектов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** НОЧНОЙ ПРОХОД ГЕО-ПОДБОРА (12.09.2026, docs/geo-match-plan-12-09.md блок E)
   *  — страховка поверх событийного механизма (lib/propertyMatchFilter.ts::
   *  notifyWaitingBuyersOfNewProperty), см. doc-comment lib/geoMatchSweep.ts.
   *
   *  08:05, а НЕ ночью и не вместе с автостатусами в 04:XX: тихие часы —
   *  21:00–08:00 (lib/pushQuietHours.ts), и проход в 04–05 утра отложил бы ВСЕ
   *  пуши до 08:00, а dedupeKey пуша строится по tag — одинаковые теги схлопнули
   *  бы весь ночной проход в одно утреннее уведомление вместо честного списка.
   *  08:05 — уже после конца тихих часов, пуши уходят сразу.
   *
   *  Тяжёлую часть (сам подбор на каждый объект) тик не делает сам — только
   *  ставит по одному заданию в очередь BackgroundJob, run() которого
   *  идемпотентен (см. jobs/geoMatchSweep.ts). */
  scheduleTracked(
    "geo-match-nightly-sweep",
    "5 8 * * *",
    async () => {
      try {
        const { candidates, enqueued } = await runNightlyGeoMatchSweepTick();
        if (enqueued) console.log(`[cron] Ночной гео-подбор: объектов ${candidates}, поставлено в очередь ${enqueued}`);
      } catch (err) {
        reportCronTickError("Ошибка ночного гео-подбора", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** НОЧНОЙ ПОИСК ДВОЙНЫХ ДОСЬЕ ПО СЛАБЫМ ПРИЗНАКАМ (план от 20.09.2026, §5.3) —
   *  одинаковое имя вместе с хвостом номера и один ник в разных мессенджерах.
   *  Только ПРЕДЛОЖЕНИЯ в очередь администратора, слияний задача не делает
   *  вовсе; подробности и почему — в doc-comment lib/contactLinkSweep.ts.
   *
   *  03:10, а не утром: задача ничего не отправляет людям, поэтому тихие часы ей
   *  безразличны, а очередь к началу рабочего дня уже полна. Отдельной минутой
   *  от уборки журналов в 03:00 и вложений в 03:30 — по той же причине, что и у
   *  них между собой: общий try/catch означал бы, что сбой одной отменяет вторую.
   *
   *  Тумблер «Ночной поиск двойных досье» (Настройки → Бот) выключен по
   *  умолчанию: выключенный тик не заводит ни одного предложения. */
  scheduleTracked(
    "contact-link-sweep",
    "10 3 * * *",
    async () => {
      try {
        const { proposed, nameAndDigits, username, skipped } = await runContactLinkSweepTick();
        if (!skipped && proposed) {
          console.log(
            `[cron] Ночной поиск двойных досье: по имени и номеру ${nameAndDigits}, по нику ${username}, предложено ${proposed}`
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка ночного поиска двойных досье", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Уборка закрытого хранилища вложений — 03:30 по Душанбе, следом за уборкой
   *  журналов. До сих пор из папки не удалялся НИ ОДИН файл: она росла только вверх
   *  и однажды переполнила бы диск целиком.
   *
   *  Срок хранения и все ограничители — в lib/privateFiles.ts, там же объяснено,
   *  почему именно 180 суток. Здесь только расписание: удаление необратимо, и
   *  решения о том, что удалять, принимаются в одном месте, а не размазаны по джобу.
   *
   *  Отдельным тиком, а не вместе с уборкой журналов в 03:00: та работает в базе и
   *  в транзакции, эта — в файловой системе. Общий try/catch на двоих означал бы,
   *  что сбой одной отменяет вторую. */
  scheduleTracked(
    "private-files-cleanup",
    "30 3 * * *",
    async () => {
      try {
        // Сперва уносим из-под уборки голосовые заметки, записанные до 02.10.2026
        // в общую папку (G2). Сбой переноса — исключение, и уборка в эту ночь не
        // идёт: лучше лишние сутки хранить вложения, чем стереть заметку.
        const { moved } = await adoptReferencedVoiceNotes();
        if (moved) console.log(`[cron] Голосовые заметки перенесены из-под уборки: ${moved}`);
        const { deleted, kept, failed, capped } = cleanupPrivateFiles();
        if (deleted || failed) {
          console.log(
            `[cron] Уборка вложений переписки: удалено ${deleted}, оставлено ${kept}` +
              (failed ? `, не удалось ${failed}` : "") +
              (capped ? ", потолок за проход исчерпан — остаток уйдёт следующей ночью" : "")
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка уборки вложений", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Обрезка истории точек возврата настроек — 03:40 по Душанбе, между уборкой
   *  вложений (03:30) и зависших видео (03:50). Своим тиком, а не довеском к
   *  соседям: общий try/catch означал бы, что сбой одной уборки отменяет вторую.
   *
   *  Основную работу делает само снятие точки (обрезает сразу после записи), а
   *  здесь закрывается второй случай: настройки не трогали месяцами, и точки
   *  устаревают по СРОКУ, а не по количеству — без ночного прохода они лежали бы
   *  вечно. Правила и числа — в lib/settingsSnapshots.ts. */
  scheduleTracked(
    "settings-snapshots-prune",
    "40 3 * * *",
    async () => {
      try {
        const { byAge, byCount } = await pruneSettingsSnapshots();
        if (byAge || byCount) {
          console.log(`[cron] Точки возврата настроек: удалено по сроку ${byAge}, по количеству ${byCount}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка обрезки точек возврата настроек", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Исходники: семь полных суток после подтверждённой публикации.
   * Материалы в работе и неопубликованные объекты сохраняются. */
  scheduleTracked(
    "stale-property-videos-cleanup",
    "50 3 * * *",
    async () => {
      try {
        const { properties, videosDeleted, failed } = await cleanupStalePropertyVideos();
        if (properties) {
          console.log(
            `[cron] Уборка зависших видео объектов: объектов ${properties}, удалено файлов ${videosDeleted}` +
              (failed ? `, не удалось ${failed}` : "")
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка уборки видео объектов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * Починка ссылки на публикацию Instagram (владелец 21.08.2026, после отчёта
   * «пересланная публикация не опознана» — 17 карточек с не-Instagram ссылкой,
   * lib/backfillInstagramUrls.ts). ФУНКЦИЯ ЛЕЖАЛА НАПИСАННОЙ, НО НИКЕМ НЕ
   * ВЫЗЫВАЛАСЬ — карточки не лечились сами, только вручную. Идемпотентна и
   * безопасна на уже верных карточках (см. её собственный комментарий), поэтому
   * гоняется каждую ночь, а не разово: лента Instagram растёт, и пост, сегодня
   * не попавший в последние 300, завтра может найтись. 03:47 — между уборкой
   * точек возврата и уборкой зависших видео, до утренних сводок, чтобы к утру
   * узнавание уже работало.
   */
  scheduleTracked(
    "instagram-url-backfill",
    "47 3 * * *",
    async () => {
      try {
        const { checked, fixed, unresolved } = await backfillInstagramUrls();
        if (fixed.length > 0) {
          console.log(
            `[cron] Ссылки на публикации Instagram: проверено ${checked}, исправлено ${fixed.length}` +
              (unresolved.length ? `, не найдено в ленте ${unresolved.length}` : "")
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка починки ссылок на публикации Instagram", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Брошенные многочастевые загрузки видео (докачка с середины, см.
   *  lib/videoUploadCleanup.ts) — 03:55 по Душанбе, следом за уборкой зависших
   *  видео объектов. Незакрытые части лежат в R2 платно, поэтому это подстраховка
   *  того же рода: файла целиком никогда не будет, если сессию забросили. */
  scheduleTracked(
    "stale-video-uploads-cleanup",
    "55 3 * * *",
    async () => {
      try {
        const { sessions, failed } = await cleanupStaleVideoUploadSessions();
        if (sessions) {
          console.log(`[cron] Уборка брошенных загрузок видео: сессий ${sessions}` + (failed ? `, не удалось ${failed}` : ""));
        }
      } catch (err) {
        reportCronTickError("Ошибка уборки брошенных загрузок видео", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Просроченные черновики нового объекта (срок жизни 7 суток, см.
   *  routes/properties/draftAttach.ts) — 03:56 по Душанбе, сразу за брошенными
   *  загрузками видео. Брошенный черновик держит на диске десятки мегабайт
   *  снимков и сотни мегабайт роликов: без уборки место кончится молча. */
  scheduleTracked(
    "expired-property-drafts-cleanup",
    "56 3 * * *",
    async () => {
      try {
        const removed = await cleanupExpiredPropertyDrafts();
        if (removed) console.log(`[cron] Уборка просроченных черновиков объектов: ${removed}`);
      } catch (err) {
        reportCronTickError("Ошибка уборки черновиков объектов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Исходящие фото/видео оператора (chat-media в R2) старше 7 суток — 03:58 по
   *  Душанбе, следом за брошенными многочастевыми загрузками. Meta уже доставила
   *  файл и держит свою копию; наша в R2 занимает место сверх согласованного
   *  срока (владелец 18.08.2026). См. lib/outgoingMediaCleanup.ts — там же почему
   *  именно 7 дней и почему без отдельной таблицы. */
  scheduleTracked(
    "outgoing-media-cleanup",
    "58 3 * * *",
    async () => {
      try {
        const { conversations, attachmentsExpired, failed } = await cleanupExpiredOutgoingMedia();
        if (conversations) {
          console.log(
            `[cron] Уборка исходящих фото/видео: диалогов ${conversations}, вложений ${attachmentsExpired}` +
              (failed ? `, не удалось ${failed}` : "")
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка уборки исходящих фото/видео", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Том своего Bot API-сервера (telegram_bot_api_data) — 03:59 по Душанбе, сразу
   *  за исходящими фото/видео. Сервер сам никогда не чистит то, что скачал или
   *  отправил (docs/journal, «диск VPS забит на 96%», 24.09.2026); свежие файлы
   *  (моложе 2 суток) не трогаем — см. lib/telegramBotApiCleanup.ts. */
  scheduleTracked(
    "telegram-bot-api-volume-cleanup",
    "59 3 * * *",
    async () => {
      try {
        const { removed, failed } = await cleanupTelegramBotApiVolume();
        if (removed) console.log(`[cron] Уборка тома Bot API: удалено файлов ${removed}` + (failed ? `, не удалось ${failed}` : ""));
      } catch (err) {
        reportCronTickError("Ошибка уборки тома Bot API", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * УБОРКА ДИСКА (Б8, 25.09.2026) — старые `-cover.jpg`, заменённые финалы и
   * обложки, временные копии бота, брошенные клипы и сырые исходники без
   * записи в базе (lib/diskCleanup.ts, там же разбор мусора по области).
   * 4:05 — после уборки тома Bot API (3:59) и до разбора звонков (4:10), чтобы
   * обе уборки не конкурировали за диск с чем-то тяжёлым одновременно.
   *
   * DRY-RUN ПО УМОЛЧАНИЮ. Правило удаления новое и трогает реальные файлы на
   * проде — прежде чем разрешить настоящее удаление, владелец должен прочитать
   * хотя бы одну строку «[cron] Уборка диска (пробный прогон…)» в логах и
   * убедиться, что цифры разумные. Переключатель — DISK_CLEANUP_DRY_RUN в
   * .env.production (0 — удалять, по умолчанию/1 — только считать).
   */
  scheduleTracked(
    "disk-cleanup",
    "5 4 * * *",
    async () => {
      try {
        const r = await runDiskCleanup({ dryRun: isDiskCleanupDryRun() });
        console.log(`[cron] ${diskCleanupSummary(r)}`);
      } catch (err) {
        reportCronTickError("Ошибка уборки диска", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Разбор всех разговоров за месяц: где агентство сильно, где просаживается.
   *  Ночью и раз в сутки — это единственный в CRM вызов модели, который смотрит на
   *  работу целиком, и он не должен ни тормозить рабочий день, ни повторяться при
   *  каждом открытии раздела «Звонки». 4:10 — после ночных уборок, чтобы разбор
   *  видел уже подчищенные данные. */
  scheduleTracked(
    "call-insights",
    "10 4 * * *",
    async () => {
      try {
        const result = await buildCallInsights(30);
        console.log(
          result.ok ? "[cron] Разбор разговоров за месяц обновлён" : `[cron] Разбор разговоров пропущен: ${result.reason}`
        );
      } catch (err) {
        reportCronTickError("Ошибка разбора разговоров", err);
      }
    },
    { timezone: "Asia/Dushanbe" },
    { module: "aiCallInsights" }
  );

  /** Отметки обработанных сообщений (защита от повторной доставки вебхука) живут
   *  три дня — Meta повторяет доставку минутами. Таблица растёт со скоростью всей
   *  входящей переписки, поэтому убирается каждую ночь, а не раз в неделю. */
  scheduleTracked(
    "webhook-dedupe-cleanup",
    "40 3 * * *",
    async () => {
      try {
        const removed = await cleanupProcessedMessages();
        if (removed) console.log(`[cron] Отметки обработанных сообщений: удалено ${removed}`);
      } catch (err) {
        reportCronTickError("Ошибка уборки отметок", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** «Итог объекта» тем, у кого объект в работе дольше положенного (Настройки).
   *  Раз в час, а не раз в сутки: срок наступает в произвольный момент, и суточный
   *  проход задерживал бы требование ещё на день. Проход идемпотентен — повторы
   *  отсекает уникальность по предмету, поэтому частота безопасна. */
  scheduleTracked(
    "property-summaries",
    "12 * * * *",
    async () => {
      try {
        const notified = await notifyOverdueMaterials();
        if (notified) console.log(`[cron] Просроченные фото/видео объекта: ${notified}`);
      } catch (err) {
        reportCronTickError("Ошибка контроля фото/видео объекта", err);
      }
      try {
        const stuck = await notifyStuckMaterials();
        if (stuck) console.log(`[cron] Объекты без материалов (видео/фото не догружены): ${stuck}`);
      } catch (err) {
        reportCronTickError("Ошибка сторожа «материалов нет»", err);
      }
      try {
        const released = await releaseExpiredReservations();
        if (released) console.log(`[cron] Резерв объекта истёк, вернули в продажу: ${released}`);
      } catch (err) {
        reportCronTickError("Ошибка снятия просроченного резерва", err);
      }
      /** Разведка 07.09.2026 (класс «осиротевшие спутники»): «Предложение
       *  реактивации», непринятое агентом дольше reactivationOfferTtlHours,
       *  раньше висело на нём НАВСЕГДА — ни TTL, ни снятия не было.
       *  09.09.2026 (замена PR #180 — docs/acceptance-08-09/PR180-review.md):
       *  напоминания агенту (25/50/75/90% TTL) + авто-принятие по факту звонка
       *  — тем же почасовым тиком, ПЕРЕД истечением TTL, без отдельного крона. */
      try {
        const { accepted, reminded } = await runReactivationOfferReminders();
        if (accepted || reminded) {
          console.log(`[cron] Предложение реактивации: авто-принято ${accepted}, напоминаний отправлено ${reminded}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка напоминаний по предложениям реактивации", err);
      }
      try {
        // Ночью не снимаем — раздавать некому, лид ждал бы утра непринятым (B10).
        const releasedOffers = await expireStaleReactivationOffers(new Date(), { onlyWorkingHours: true });
        if (releasedOffers) console.log(`[cron] Предложение реактивации: срок истёк у ${releasedOffers}`);
      } catch (err) {
        reportCronTickError("Ошибка снятия просроченных предложений реактивации", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Бездействие по принятым клиентам: сначала предупреждение, потом штраф.
   *  Раз в сутки утром, а не чаще: это разговор с человеком о его работе, и
   *  повторять его каждый час — не контроль, а травля. 09:20, когда рабочий день
   *  уже начался и предупреждение можно отработать сегодня же. */
  scheduleTracked(
    "inactivity-check",
    "20 9 * * *",
    async () => {
      try {
        const { warned, penalized } = await runInactivityCheck();
        if (warned || penalized) {
          console.log(`[cron] Бездействие: предупреждений ${warned}, штрафов ${penalized}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка проверки бездействия", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Ночной AI-скоринг клиентов (7.2) — каждый день в 02:00 по Душанбе.
   *  timezone здесь обязателен и раньше единственный из всех джобов его не имел:
   *  без опции node-cron берёт время процесса, а контейнер живёт в UTC — «02:00»
   *  превращалось в 07:00 по Душанбе. Скоринг всех активных клиентов (последовательные
   *  вызовы модели) приходился ровно на начало рабочего дня и конкурировал с ботом. */
  scheduleTracked(
    "client-scoring",
    "0 2 * * *",
    async () => {
      console.log("[cron] Запуск ночного AI-скоринга клиентов...");
      try {
        const { scored, skipped, fresh, deferred } = await scoreAllActiveClients();
        console.log(
          `[cron] Скоринг завершён: оценено ${scored}, пропущено ${skipped}, свежих ${fresh}, отложено до следующей ночи ${deferred}`
        );
      } catch (err) {
        reportCronTickError("Ошибка скоринга", err);
      }
    },
    { timezone: "Asia/Dushanbe" },
    { module: "aiClientScoring" }
  );

  /**
   * Разбор ошибок бота: сырые случаи (вместо бота ответил человек / клиент
   * переспросил) превращаются в короткие правила и подмешиваются в промт.
   *
   * КАЖДЫЕ ДВА ЧАСА, А НЕ РАЗ В НОЧЬ (требование владельца 16.08.2026: «главное,
   * чтобы свои ошибки для будущих клиентов быстро исправлял»). Ночной разбор означал,
   * что ошибка, сделанная в 9 утра, повторялась со всеми клиентами до следующего
   * утра — под рекламой это сотни человек за день. Теперь между промахом и правилом
   * проходит не сутки, а часа два.
   *
   * В 30 минут каждого чётного часа: в 2:30 совпадает с прежним временем и по-прежнему
   * идёт после скоринга, чтобы две задачи с вызовами ИИ не начинались одновременно.
   * Расход невелик — разбираются только новые случаи, а их за два часа единицы.
   */
  scheduleTracked(
    "bot-lessons",
    "30 */2 * * *",
    async () => {
      try {
        const { learned } = await distillLessons();
        if (learned > 0) console.log(`[cron] Бот вывел новых правил из своих ошибок: ${learned}`);
      } catch (err) {
        reportCronTickError("Ошибка разбора обучения бота", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * СУДЬЯ ДИАЛОГОВ — ПО РАСПИСАНИЮ, А НЕ ПО КНОПКЕ (совет экспертов 26.08, п. 8).
   *
   * runBotAudit сверяет вчерашние переписки с правилами промта и складывает
   * нарушения в BotAuditFinding — но запускался ТОЛЬКО кнопкой в Настройках,
   * то есть тогда, когда кто-то вспомнит. Промт в тысячу с лишним строк при
   * этом правится вслепую: правку выкатывают и надеются. Ночной прогон делает
   * качество бота измеряемым само по себе — утром видно, что он вчера нарушил.
   *
   * В 3:15, после уроков бота (2:30) и разбора потерянных (2:45): три задачи с
   * вызовами ИИ не должны начинаться одновременно — общий ключ у них один.
   * Окно — месяц, диалоги из него берутся случайные и только не судимые ранее
   * (30.08.2026): прежние «сутки с прошлого прогона» означали, что диалог, чья
   * ночь пропущена — из-за отказа модели, выходных, простоя, — не проверялся уже
   * никогда, а после простоя выборка выходила пустой.
   */
  let isBotAuditRunning = false;
  scheduleTracked(
    "bot-audit",
    "15 3 * * *",
    async () => {
      if (isBotAuditRunning) return;
      isBotAuditRunning = true;
      try {
        const { conversationsChecked, findingsCreated } = await runBotAudit();
        if (conversationsChecked > 0) {
          console.log(`[cron] Судья диалогов: проверено ${conversationsChecked}, нарушений найдено ${findingsCreated}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка ночного аудита бота", err);
      } finally {
        isBotAuditRunning = false;
      }
    },
    { timezone: "Asia/Dushanbe" },
    { module: "aiBotAudit" }
  );

  /** Разбор переписок, кончившихся ничем (заявки нет, человек не вернулся) — в 2:45,
   *  третьей в ночной очереди вызовов ИИ, после скоринга и разбора ошибок бота.
   *
   *  Почему ночью, а не раз в неделю всей кучей: расход на ИИ размазан и ограничен
   *  потолком на проход (см. lostConversations.ts), а переписка ещё свежая. Выводы
   *  отсюда в промт НЕ идут — они копятся до недельной сводки владельцу. */
  scheduleTracked(
    "lost-conversations",
    "45 2 * * *",
    async () => {
      try {
        const analyzed = await analyzeLostConversations();
        if (analyzed > 0) console.log(`[cron] Разобрано оборванных переписок: ${analyzed}`);
      } catch (err) {
        reportCronTickError("Ошибка разбора оборванных переписок", err);
      }
    },
    { timezone: "Asia/Dushanbe" },
    { module: "aiLostConversations" }
  );

  /** Недельная сводка «куда уходят клиенты» — понедельник, 09:00 по Душанбе, за
   *  семь прошедших суток. Утро понедельника: владелец получает один список на
   *  неделю в начале рабочей недели, а не ежедневный шум «вчера ушли двое».
   *  Повторный запуск за ту же неделю ничего не дублирует (periodStart уникален). */
  scheduleTracked(
    "weekly-lost-digest",
    "0 9 * * 1",
    async () => {
      try {
        const { created, lostCount, proposals } = await buildWeeklyLostDigest();
        if (!created) return;
        console.log(`[cron] Сводка по оборванным перепискам: ${lostCount} шт., предложений ${proposals}`);
        await notifyDirectorsAboutLostDigest(lostCount, proposals);
      } catch (err) {
        reportCronTickError("Ошибка недельной сводки по потерям", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * РАЗБОР ПРОБЛЕМНЫХ МЕСТ ЗА НЕДЕЛЮ — понедельник, 09:10 по Душанбе (решение
   * владельца 11.08.2026). Утро понедельника выбрано тем же соображением, что и у
   * сводки по оборванным перепискам: один разбор на неделю в начале рабочей недели,
   * а не ежедневный шум.
   *
   * Десять минут после сводки, а не ровно в 09:00: оба джоба делают десятки запросов
   * к базе, и запускать их в одну секунду значит без нужды складывать нагрузку —
   * а пуш «отчёт готов» вперемешку со вторым пушем читается как один.
   *
   * Выключенный в Настройках отчёт не собирается вовсе — решение принимает сама
   * generateProblemReport, чтобы кнопка «Собрать сейчас» вела себя так же.
   */
  scheduleTracked(
    "weekly-problem-report",
    "10 9 * * 1",
    async () => {
      try {
        const { created, reason, periodStart } = await generateProblemReport("week");
        if (created) console.log(`[cron] Разбор проблемных мест за неделю с ${dushanbeWallClock(periodStart).toISOString().slice(0, 10)}`);
        else if (reason === "exists") console.log("[cron] Разбор за эту неделю уже собран");
      } catch (err) {
        reportCronTickError("Ошибка недельного разбора проблемных мест", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ИИ-РАЗБОР МАРКЕТИНГА — ПУШ РАЗ В НЕДЕЛЮ (05.09.2026,
   * docs/ai-proactivity-audit-05-09-2026.md п.1). Тот же разбор, что строится по
   * открытию экрана отчётов (lib/marketingInsights.ts), теперь ещё и сам приходит.
   * 09:20 — на десять минут позже недельного разбора проблемных мест выше, чтобы
   * не складывать две тяжёлые сборки с обращением к ИИ в одну минуту.
   */
  scheduleTracked(
    "weekly-marketing-insights",
    "20 9 * * 1",
    async () => {
      try {
        await notifyReportsAboutMarketingInsights();
      } catch (err) {
        markCronTickFailed("Ошибка еженедельного разбора маркетинга", err);
        void logSystemError("ai", `Еженедельный пуш с разбором маркетинга не отправлен: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ЕЖЕНЕДЕЛЬНОЕ НАПОМИНАНИЕ О ВЕРОЯТНЫХ ДУБЛИКАТАХ (владелец 06.09.2026, разбор
   * слепых зон п.3) — тот же понедельник, что у «Разбора недели» выше, но на
   * 10 минут позже (та же причина: не складывать тяжёлые задачи в одну минуту)
   * и ОТДЕЛЬНЫМ лёгким пушем, не частью того отчёта. См. lib/duplicatesWeeklyDigest.ts.
   */
  scheduleTracked(
    "duplicates-weekly-digest",
    "20 9 * * 1",
    async () => {
      try {
        const { notified } = await runDuplicatesWeeklyDigestTick();
        if (notified > 0) console.log(`[cron] Напоминание о дублях клиентов: отправлено ${notified}`);
      } catch (err) {
        reportCronTickError("Ошибка напоминания о дублях клиентов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * НЕДЕЛЬНАЯ СВОДКА СБ — понедельник, 09:20 по Душанбе (план 03.09.2026, §E,
   * п. 2-3). «43 отказа за неделю, 5 со сделкой на стороне, из них 3 у
   * Фарруха — у остальных агентов 0-1» — пуш руководству, тем же приёмом, что
   * у weekly-lost-digest/weekly-problem-report выше. Десять минут после
   * недельного разбора проблемных мест (09:10) — не складывать тяжёлые
   * сборки в одну минуту, та же причина, что и у него самого относительно
   * сводки по перепискам (09:00).
   *
   * УПРОЩЕНО НАМЕРЕННО (решение агента, задача §E, п. 3): вместо отдельного
   * трекинга «кто открывал сводку» и эскалации «никто не открыл 3 дня» — крон
   * раз в неделю сам шлёт сводку всем с правом reports.view, без слежения за
   * просмотром. Полноценный трекинг «прочитано/не прочитано» потребовал бы
   * либо новую модель с меткой времени последнего просмотра, либо отдельное
   * поле в Settings — заметная площадь ради функции, которую владелец прямо
   * назвал необязательной («можно ограничиться … это тоже приемлемо»), если
   * сводка и так уходит пушем каждую неделю сама, без ожидания, что её кто-то
   * откроет руками.
   *
   * Пустая неделя (случаев СБ не было) — пуш не уходит вовсе, тот же приём,
   * что у weekly-lost-digest: «сводка пуста» раз в неделю — шум, из-за
   * которого перестают открывать даже непустые сводки.
   *
   * ДЕДУП — Notification.tag несёт дату начала недели: повторный тик в ту же
   * неделю (перезапуск процесса ровно в 09:20) находит уже отправленную
   * запись и не шлёт пуш дважды. upsertByTag внутри createNotification при
   * этом всё равно обновит ленту (count++), но здесь до него не доходит —
   * ранний выход по прямому запросу в Notification.
   */
  scheduleTracked(
    "weekly-security-review-digest",
    "20 9 * * 1",
    async () => {
      try {
        const digest = await buildSecurityReviewDigest();
        if (digest.securityReviewCount === 0) return;

        const tag = `security-review-digest-${digest.from.toISOString().slice(0, 10)}`;
        const already = await prisma.notification.findFirst({ where: { tag }, select: { id: true } });
        if (already) return;

        const recipients = await investigationRecipients();
        if (recipients.length === 0) return;

        const anomalies = digest.byAgent.filter((a) => a.anomaly);
        const body =
          `За неделю ${digest.totalRefusals} ${pluralizeRu(digest.totalRefusals, ["отказ", "отказа", "отказов"])}, ` +
          `из них ${digest.securityReviewCount} ${pluralizeRu(digest.securityReviewCount, ["случай", "случая", "случаев"])} — возможно, сделка ушла на сторону.` +
          (anomalies.length > 0
            ? ` Выделяется: ${anomalies.map((a) => `${a.agentName} (${a.count})`).join(", ")}.`
            : "");

        await Promise.all(
          recipients.map((id) =>
            sendPushToAgent(id, {
              title: "🛡️ Сводка СБ за неделю",
              body,
              url: "/reports",
              tag,
              kind: "oversight",
            })
          )
        );
        console.log(
          `[cron] Сводка СБ за неделю: ${digest.securityReviewCount} случаев из ${digest.totalRefusals} отказов, получателей ${recipients.length}`
        );
      } catch (err) {
        reportCronTickError("Ошибка недельной сводки СБ", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * РЕАКТИВАЦИЯ СТАРЫХ КЛИЕНТОВ ПАЧКОЙ (Пачка 12, 11.09.2026,
   * docs/gaps-audit-11-09.md). Понедельник, 10:00 по Душанбе — после утренних
   * недельных сводок (09:00/09:10/09:20 выше), чтобы не класть ещё один
   * тяжёлый проход по базе в ту же минуту. Сам тик только СТАВИТ задания
   * (jobs/clientReactivation.ts) — выключенный тумблер Settings.reactivationEnabled
   * решает вопрос ещё до выборки, см. lib/reactivationCampaign.ts.
   */
  scheduleTracked(
    "weekly-reactivation-campaign",
    "0 10 * * 1",
    async () => {
      try {
        const { enqueued, skipped } = await runReactivationCampaignTick();
        if (skipped === "disabled") return;
        if (enqueued > 0) console.log(`[cron] Реактивация старых клиентов: поставлено заданий ${enqueued}`);
      } catch (err) {
        reportCronTickError("Ошибка недельной реактивации клиентов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Тот же разбор за МЕСЯЦ — 1-го числа в 09:10, за прошедший календарный месяц.
   *  Отдельно от месячного отчёта (тот в 09:00 отвечает «сколько заработали», этот —
   *  «где теряем»), и на десять минут позже него по той же причине: не складывать
   *  две тяжёлые сборки в одну минуту. */
  scheduleTracked(
    "monthly-problem-report",
    "10 9 1 * *",
    async () => {
      try {
        const { created, periodStart } = await generateProblemReport("month");
        if (created) console.log(`[cron] Разбор проблемных мест за ${dushanbeWallClock(periodStart).toISOString().slice(0, 7)}`);
      } catch (err) {
        reportCronTickError("Ошибка месячного разбора проблемных мест", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ПЕРЕНАЗНАЧЕНИЕ ПРОСРОЧЕННЫХ ОФФЕРОВ — БЕЗ ГЕЙТА РАБОЧИХ ЧАСОВ (14.09.2026,
   * скриншоты владельца: карточка «Сафия» висела на «осталось 0:00» с живыми
   * кнопками Принять/Отклонить до утра, потому что `reassignStaleLeads` раньше
   * сидела в одном тике с `assignPendingLeads` и ждала `isWithinWorkingHours()`
   * заодно с ней).
   *
   * ЭТО ДРУГОЙ СЛУЧАЙ, чем «утренняя волна» ниже: лид здесь уже был показан
   * живому агенту (offer с честным дедлайном на экране, IncomingLeadWindow.tsx)
   * — таймер на телефоне не может корректно досчитать до нуля и потом соврать,
   * что время ещё не вышло. `assignPendingLeads`, наоборот, раздаёт СОВСЕМ
   * новые лиды без агента — тем можно и нужно подождать утра, чтобы не будить
   * никого пуском с нуля.
   *
   * ВЛАДЕЛЕЦ РЕШИЛ ИНАЧЕ (23.09.2026, ПР-000453): после правила 17.09 «пусть
   * крутится» ночной круг не останавливался вовсе и до утра будил агентов и
   * штрафовал их. Теперь ночью круг стоит (staleLeadCircleOpen):
   * лид остаётся у держателя, принять его можно, экран пишет «время вышло»
   * вместо «уходит дальше», утром круг продолжает с того же лида.
   */
  /**
   * РАЗ В МИНУТУ, А НЕ РАЗ В 5 МИНУТ (владелец 22.09.2026, живой случай ПР-000424:
   * назначил лид сам в 10:18, хотя окно приёма истекло в 10:15 — первый тик,
   * который вообще имел право тронуть карточку, был только в 10:20).
   *
   * `candidateWindow` сравнивает `assignedAt < now - leadAcceptMinutes` СТРОГО,
   * и при тике раз в 5 минут это превращает «15 минут на приём» в «15–20»: тик
   * в 10:15 видит лид, назначенный в 10:00:0x, ещё живым (10:00:0x не меньше
   * 10:00:00), и первый тик, способный его подвинуть, — только 10:20. Таймер
   * же на экране агента (IncomingLeadWindow.tsx) честно считает от
   * leadAcceptMinutes и показывает 0:00 ровно на 15-й минуте — обещание и
   * дело расходятся на те же 0-5 минут, и заметно это только когда владелец
   * успевает вмешаться раньше кода.
   */
  let isStaleLeadReassignRunning = false;
  scheduleTracked("lead-stale-reassignment", "* * * * *", async () => {
    if (isStaleLeadReassignRunning) return;
    isStaleLeadReassignRunning = true;
    try {
      // Ночью (вне «Когда лиды уходят агентам») круг стоит — см. шапку
      // staleLeadCircleOpen (владелец 23.09.2026).
      if (await staleLeadCircleOpen()) {
        const { moved, escalated } = await reassignStaleLeads();
        if (moved > 0) console.log(`[cron] Переназначено непринятых лидов: ${moved}`);
        if (escalated > 0) console.log(`[cron] Эскалировано (никто не принял): ${escalated}`);
      }
    } catch (err) {
      reportCronTickError("Ошибка переназначения лидов", err);
    } finally {
      isStaleLeadReassignRunning = false;
    }
    /**
     * Живой случай 15.09.2026: лид, эскалированный один раз, провисел непринятым
     * с 21 августа — пуш руководителям уходил только в момент самой эскалации,
     * не заметили и всё, дальше карточка выпадала из всех проверок навсегда.
     * Тот же тик (раз в 5 минут), отдельный try/catch — сбой напоминаний не
     * должен ронять переназначение выше.
     */
    try {
      const { reminded } = await remindEscalatedLeads();
      if (reminded > 0) console.log(`[cron] Повторных напоминаний по эскалированным лидам отправлено: ${reminded}`);
    } catch (err) {
      reportCronTickError("Ошибка напоминаний по эскалированным лидам", err);
    }
  });

  /** Утренняя волна назначения накопленных за ночь лидов (assignPendingLeads) —
   *  каждые 5 минут, но ТОЛЬКО в рабочие часы (Настройки → workHoursStart/End).
   *  Первый тик после начала рабочего дня естественно разгребает весь ночной
   *  "завал" — отдельный разовый джоб не нужен. isDistributionRunning —
   *  node-cron НЕ ждёт завершения предыдущего вызова перед следующим тиком; при
   *  большом "завале" один проход может занять больше 5 минут, и без гварда два
   *  тика обрабатывали бы одни и те же лиды параллельно. */
  let isDistributionRunning = false;
  scheduleTracked("lead-distribution", "*/5 * * * *", async () => {
    if (!(await isWithinWorkingHours())) return;
    if (isDistributionRunning) return;
    isDistributionRunning = true;
    try {
      const assigned = await assignPendingLeads();
      if (assigned > 0) console.log(`[cron] Назначено лидов, ждавших агента: ${assigned}`);
    } catch (err) {
      reportCronTickError("Ошибка назначения накопленных лидов", err);
    }
    try {
      const { penalized } = await penalizeMissedFirstCalls();
      if (penalized > 0) console.log(`[cron] Первый звонок сорван, лид снят: ${penalized}`);
    } catch (err) {
      reportCronTickError("Ошибка штрафа за сорванный звонок", err);
    }
    try {
      // Пуш агенту за 5 минут до срока (задание 17.09.2026) — тот же тик, что и
      // сам штраф выше: окно выборки внутри remindDueFirstCalls совпадает с
      // частотой тика, так что каждая карточка попадает в него ровно один раз.
      const { reminded: callReminders } = await remindDueFirstCalls();
      if (callReminders > 0) console.log(`[cron] Напоминаний о первом звонке отправлено: ${callReminders}`);
    } catch (err) {
      reportCronTickError("Ошибка напоминания о первом звонке", err);
    }
    try {
      // Таймер возврата (владелец 21.08.2026, Р-5 17.09.2026 — передачи по
      // таймеру больше нет, только напоминание прежнему агенту и, если не
      // тронул ещё дольше, эскалация руководителю) — в том же тике, что и
      // остальная разборка непринятого.
      const { reminded: returnsReminded, escalated: returnsEscalated } = await reassignStaleReturns();
      if (returnsReminded > 0) console.log(`[cron] Напоминаний о вернувшихся клиентах: ${returnsReminded}`);
      if (returnsEscalated > 0) console.log(`[cron] Вернувшихся клиентов эскалировано руководителю: ${returnsEscalated}`);
    } catch (err) {
      reportCronTickError("Ошибка обработки вернувшихся клиентов", err);
    }
    try {
      // Раздел L, главное правило (03.09.2026) — тот же принцип и тот же тик, что
      // у таймера возврата выше: не ответил вовремя — заявка уходит в обычную
      // раздачу как отдельный человек, а не висит бесконечно.
      const { expired } = await sweepExpiredDuplicateReviews(new Date(), assignHeldLead);
      if (expired > 0) console.log(`[cron] Проверок дубля просрочено, лиды переданы в очередь: ${expired}`);
    } catch (err) {
      reportCronTickError("Ошибка снятия просроченных проверок на дубль", err);
    }
    try {
      // Предупреждение за 25% до истечения (аудит владения 11.09.2026, дыра №5) —
      // тот же тик, что и снятие просроченных выше.
      const { reminded } = await remindDuplicateReviewsNearingExpiry();
      if (reminded > 0) console.log(`[cron] Предупреждений о скорой просрочке проверки дубля: ${reminded}`);
    } catch (err) {
      reportCronTickError("Ошибка предупреждения о скорой просрочке проверки дубля", err);
    } finally {
      isDistributionRunning = false;
    }
  });

  /**
   * СВЕТОФОР НЕАКТИВНЫХ (владелец 20-21.08.2026) — каждые 30 минут, сама функция
   * решает, кому в этот тик действительно пора напоминание (шаг светофора считается
   * часами, 30 минут — запас точности без лишней нагрузки на базу) и молчит вне
   * рабочих часов (isWithinWorkingHours внутри runInactiveTrafficLightTick).
   */
  scheduleTracked("inactive-traffic-light", "*/30 * * * *", async () => {
    try {
      const { pinged, lost } = await runInactiveTrafficLightTick();
      if (pinged > 0) console.log(`[cron] Светофор неактивных: напоминаний ${pinged}`);
      if (lost > 0) console.log(`[cron] Светофор неактивных: переведено в Потерянные ${lost}`);
    } catch (err) {
      reportCronTickError("Ошибка светофора неактивных", err);
    }
  });

  /**
   * ВОЗВРАТ «ОТЛОЖЕННЫХ» (задача G, план 03-04.09.2026) — та же частота, что у
   * светофора неактивных: тик дешёвый (индекс [workStatus, deferredUntil]),
   * почти всегда выборка пустая. Ранний возврат (клиент написал/позвонил сам)
   * этого тика не ждёт — см. services/leads/intake.ts и
   * lib/telephony/inboundRouting.ts (returnDeferredClientEarly).
   */
  scheduleTracked("deferred-clients-return", "*/30 * * * *", async () => {
    try {
      const { returned } = await runDeferredClientsReturnTick();
      if (returned > 0) console.log(`[cron] Отложенные: возвращено в работу ${returned}`);
    } catch (err) {
      reportCronTickError("Ошибка возврата отложенных клиентов", err);
    }
  });

  /**
   * АНТИФРОД «ПРОДАВЕЦ БЕЗ ОБЪЕКТА» (владелец 21.08.2026) — та же частота, что у
   * светофора неактивных: критичные случаи (Settings.sellerPropertyMissingCriticalDays)
   * уходят в очередь СБ (lib/sellerPropertyMissingAntifraud.ts, дедуп встроен в саму
   * функцию — securityReview меняется только null→PENDING).
   */
  scheduleTracked("seller-property-missing", "*/30 * * * *", async () => {
    try {
      const { escalated } = await escalateSellerPropertyMissing();
      if (escalated > 0) console.log(`[cron] Продавец без объекта: передано в СБ ${escalated}`);
    } catch (err) {
      reportCronTickError("Ошибка антифрода «продавец без объекта»", err);
    }
  });

  /**
   * АЛАРМ ДИРЕКТОРУ «СЪЁМКА БЫЛА, ОБЪЕКТ НЕ ПРИНЯТ» (требование 7, аудит 02.09.2026;
   * переработан 09.09.2026). Точка отсчёта — услышанная ИИ дата приёмки (исход
   * SELLER_MEETING с датой, где бы он ни стоял), порог 2 дня, БЕЗ фильтра по
   * скорингу, получатель только DIRECTOR. «Объект принят» = материалы сданы:
   * пустая карточка тревогу не гасит. Дедуп по tag. НЕ замена старого антифрода
   * (тот эскалирует в СБ на 5 день), а дополнительный ранний сигнал.
   */
  /**
   * ЗОНД СТАНЦИИ (дыра 4.2 карты решений 09.09.2026).
   *
   * Раз в пять минут — один дешёвый GET /ari/asterisk/info. Всё, что он делает:
   * отмечает в StationOutage окна, когда CRM не могла достучаться до телефонии.
   * Эти часы потом вычитаются из счётчиков тишины (lib/stationOutage.ts), иначе
   * день без АТС превращается в тревогу разом по всем агентам — самый быстрый
   * способ убить доверие к системе контроля.
   *
   * Пять минут, а не час: простой измеряется в часах, но границу надо знать
   * точнее часа, иначе поправка сама станет источником вранья в обе стороны.
   */
  scheduleTracked("station-outage-probe", "*/5 * * * *", async () => {
    try {
      await runStationOutageProbeTick();
    } catch (err) {
      reportCronTickError("Ошибка зонда станции", err);
    }
  });

  /**
   * «АГЕНТ САМ ПЕРЕСТАЛ ПЫТАТЬСЯ» (владелец 16.09.2026) — читатель вердикта «работа
   * встала», которого не было: отметка попытки писалась, вердикт был покрыт тестами,
   * а спрашивать его было некому, и фундамент контроля ни разу не сработал.
   *
   * Лесенка укладывается в три дня по прямому указанию владельца («слишком долгие
   * паузы не делай»): 2 рабочих дня тишины — пуш САМОМУ агенту, 3 — строка владельцу
   * после ИИ-проверки, не объяснил ли клиент паузу сам. Одно уведомление на человека
   * в сутки, а не на карточку. См. lib/sellerWorkStalledAlarm.ts.
   */
  scheduleTracked("seller-work-stalled-alarm", "20 * * * *", async () => {
    try {
      const { pokedAgents, reportedToDirector, skipped } = await runSellerWorkStalledAlarmTick();
      if (pokedAgents > 0 || reportedToDirector > 0) {
        console.log(
          `[cron] Работа встала: агентов ${pokedAgents}, владельцу ${reportedToDirector}, объяснено клиентом ${skipped}`
        );
      }
    } catch (err) {
      reportCronTickError("Ошибка аларма «работа встала»", err);
    }
  });

  scheduleTracked("seller-no-property-alarm", "0 * * * *", async () => {
    try {
      const { alerted } = await runSellerNoPropertyAlarmTick();
      if (alerted > 0) console.log(`[cron] Аларм «продавец без объекта после съёмки»: ${alerted}`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «продавец без объекта после съёмки»", err);
    }
  });

  scheduleTracked("video-handoff-stale-alarm", "0 * * * *", async () => {
    try {
      const { alerted } = await runVideoHandoffStaleAlarmTick();
      if (alerted > 0) console.log(`[cron] Аларм «монтаж завис»: ${alerted}`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «монтаж завис»", err);
    }
  });

  /**
   * ГОТОВЫЙ РОЛИК ЖДЁТ ПРОВЕРКИ ДОЛЬШЕ 3 ЧАСОВ (25.09.2026, lib/clipReview.ts) —
   * напоминание модераторам, не чаще раза в 6 часов на объект, в часы алармов.
   */
  scheduleTracked("clip-review-resend", "*/5 * * * *", async () => {
    try {
      const { resent } = await runClipReviewResendTick();
      if (resent > 0) console.log(`[cron] Досылка проверки ролика модератору: ${resent}`);
    } catch (err) {
      reportCronTickError("Ошибка досылки проверки ролика", err);
    }
  });

  scheduleTracked("clip-review-stale-alarm", "15 * * * *", async () => {
    try {
      const { reminded } = await runClipReviewStaleAlarmTick();
      if (reminded > 0) console.log(`[cron] Напоминание «ролик ждёт проверки»: ${reminded}`);
    } catch (err) {
      reportCronTickError("Ошибка напоминания «ролик ждёт проверки»", err);
    }
  });

  /**
   * СТОРОЖ НЕДОВЕДЁННЫХ ПУБЛИКАЦИЙ (случай №114, 21.09.2026) — см. докстринг
   * lib/videoHandoffUnfinishedPublishWatchdog.ts. Раз в 5 минут: узкий
   * остаточный случай (задание публикации не встало в очередь вовсе), основная
   * защита — сама очередь заданий (jobs/runner.ts, подбор зависших RUNNING).
   */
  /**
   * СТОРОЖ ДОСТАВКИ ИСХОДНИКОВ МОНТАЖЁРУ (объект №121, 22.09.2026) — см.
   * lib/videoHandoffRedelivery.ts. Досылает то, что заняло место монтажёра, но
   * не дошло (процесс умер посреди отправки), и выдаёт следующего из очереди,
   * если место свободно, а очередь стоит.
   */
  scheduleTracked("video-handoff-redelivery", "*/5 * * * *", async () => {
    try {
      const { redelivered, gaveUp, released, alerted, manualExpired } = await runVideoHandoffRedeliveryTick();
      if (redelivered > 0 || gaveUp > 0 || released || alerted > 0 || manualExpired > 0) {
        console.log(
          `[cron] Сторож доставки монтажёру: дослано ${redelivered}, сдались ${gaveUp}, очередь сдвинута: ${released}, тревог ${alerted}, снято ручных ожиданий ${manualExpired}`
        );
      }
    } catch (err) {
      reportCronTickError("Ошибка сторожа доставки монтажёру", err);
    }
  });

  scheduleTracked("video-handoff-unfinished-publish-watchdog", "*/5 * * * *", async () => {
    try {
      const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();
      if (recovered > 0) console.log(`[cron] Сторож недоведённых публикаций: восстановлено ${recovered}`);
    } catch (err) {
      reportCronTickError("Ошибка сторожа недоведённых публикаций", err);
    }
  });

  /**
   * Подписка аккаунтов Instagram на наши уведомления и сторож тишины
   * (02.10.2026, lib/instagramWebhookSubscription.ts). С 21.09 Meta перестала
   * присылать события Royal Home Info, и одиннадцать дней этого не видел никто:
   * подписку CRM не проверяла вовсе. Каждые три часа — два коротких запроса на
   * аккаунт; пропуск восстанавливается сам, итог пишется в журнал.
   */
  scheduleTracked("instagram-webhook-subscriptions", "25 */3 * * *", async () => {
    try {
      const { restored, failed, silent } = await runInstagramSubscriptionWatch();
      if (restored || failed || silent) {
        console.log(
          `[cron] Подписка Instagram: восстановлено ${restored}, не проверено ${failed}, замолчавших аккаунтов ${silent}`
        );
      }
    } catch (err) {
      reportCronTickError("Ошибка проверки подписки Instagram на уведомления", err);
    }
  }, { timezone: "Asia/Dushanbe" });

  /**
   * ДОЗАВЕРШЕНИЕ ОТЛОЖЕННЫХ КОНТЕЙНЕРОВ INSTAGRAM (случай №111, 21.09.2026) —
   * см. докстринг lib/instagramPendingContainers.ts. Каждые 5 минут: контейнер
   * живёт у Meta 24 часа, частый опрос не нужен и тратит впустую квоту API.
   */
  scheduleTracked("instagram-pending-containers", "*/5 * * * *", async () => {
    try {
      const { published, rejected, expired, cancelled } = await runInstagramPendingContainersTick();
      if (published || rejected || expired || cancelled) {
        console.log(
          `[cron] Отложенные контейнеры Instagram: опубликовано ${published}, отклонено ${rejected}, ` +
            `протухло ${expired}, отменено вместе с объектом ${cancelled}`
        );
      }
    } catch (err) {
      reportCronTickError("Ошибка дозавершения отложенных контейнеров Instagram", err);
    }
  });

  /**
   * ЕЖЕДНЕВНАЯ ПОДБОРКА СТОРИС (28.09.2026) — см. докстринг lib/dailyStories.ts.
   * Тик каждые 15 минут, сама функция решает, наступил ли час
   * Settings.dailyStoriesHourDushanbe и не запускали ли уже сегодня
   * (Settings.dailyStoriesLastRunAt) — перезапуск сервера посреди часа не даёт
   * второй прогон. Публикация нескольких объектов идёт минутами (пауза 20с
   * между ними) — таймаут тика поднят явно, дефолтный (2×15мин) с запасом
   * хватает, но явная цифра читается понятнее.
   */
  scheduleTracked(
    "daily-stories",
    "*/15 * * * *",
    async () => {
      try {
        const result = await runDailyStoriesTick();
        if (result.ran) {
          console.log(
            `[cron] Ежедневная подборка сторис: кандидатов ${result.candidateCount}, опубликовано ${result.published}, не удалось ${result.failed}`
          );
        }
      } catch (err) {
        reportCronTickError("Ошибка ежедневной подборки сторис", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * СТАТИСТИКА САЙТА ROYALHOME.TJ (24.09.2026) — раз в час забираем с сайта
   * посещаемость по часам и объекты по дням (lib/siteStats.ts). Минута 7 — не
   * ровно в начало часа, когда сайт ещё дописывает прошлый час. Пока связь с
   * сайтом не настроена, сбор молча пропускается: это не поломка.
   */
  scheduleTracked("site-stats", "7 * * * *", async () => {
    try {
      const result = await collectSiteStats();
      if (result.ok) {
        console.log(`[cron] Статистика сайта: часов ${result.hours}, объекто-дней ${result.days}, не найдено в CRM ${result.unmatched}`);
        // «Объект загорелся» — сразу по свежим числам, тем же часом (lib/propertyHotAlert.ts).
        try {
          const hot = await notifyHotProperties();
          if (hot > 0) console.log(`[cron] «Объект загорелся»: уведомлено агентов ${hot}`);
        } catch (err) {
          void logSystemError("api", `«Объект загорелся» не разослан: ${err instanceof Error ? err.message : String(err)}`, {
            dedupKey: "property-hot-alert",
          });
        }
      } else if (!result.notConfigured) {
        // Сайт ещё без выдачи статистики — ждём его выката, напоминание раз в сутки.
        void logSystemError("site-sync", `Статистика сайта не собрана: ${result.error}`, {
          dedupKey: result.siteNotDeployed ? "site-stats-not-deployed" : "site-stats",
          ...(result.siteNotDeployed ? { dedupWindowMs: 24 * 60 * 60 * 1000 } : {}),
        });
      }
    } catch (err) {
      reportCronTickError("Ошибка сбора статистики сайта", err);
    }
  });

  /**
   * ПОДПИСЧИКИ INSTAGRAM В СЕТИ ПО ЧАСАМ (23.09.2026) — см. «Суточный сбор» в
   * lib/instagramInsights.ts. Meta хранит эти часы 30 дней, поэтому забираем
   * каждый день: без сбора история длиннее месяца не появится никогда. Время —
   * после полудня по Душанбе: сутки Meta кончаются в полночь по Калифорнии
   * (10:00–11:00 по Душанбе), и к 14:15 вчерашний день уже закрыт. Отказ Meta —
   * в журнал ошибок: иначе карта и расписание тихо жили бы на старых данных.
   */
  scheduleTracked(
    "instagram-online-followers",
    "15 14 * * *",
    async () => {
      try {
        const result = await collectInstagramOnlineFollowers();
        if (result.ok) {
          console.log(`[cron] Подписчики Instagram в сети: записано часов ${result.stored}`);
        } else {
          void logSystemError("meta", `Сбор «подписчики Instagram в сети» не удался: ${result.error}`, {
            dedupKey: "instagram-online-followers",
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[cron] Ошибка сбора подписчиков Instagram в сети:", reason);
        void logSystemError("meta", `Сбор «подписчики Instagram в сети» упал: ${reason}`, {
          dedupKey: "instagram-online-followers",
        });
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ЕЖЕСУТОЧНАЯ СВЕРКА ПУБЛИКАЦИЙ (владелец, 22.09.2026) — см. докстринг
   * lib/publishedChannelsAudit.ts. Раз в сутки: ищет каналы, которые карточка
   * считает опубликованными, а поста там уже нет (случай №112). Ночью и в
   * пустой час — проход стоит до 450 обращений к чужим API, днём они нужнее
   * живым публикациям.
   */
  scheduleTracked(
    "published-channels-audit",
    "20 5 * * *",
    async () => {
      try {
        const { checked, cleared, unknown } = await runPublishedChannelsAuditTick();
        if (checked > 0) {
          console.log(`[cron] Сверка публикаций: проверено ${checked}, снято отметок ${cleared}, не проверено ${unknown}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка сверки публикаций", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * «ПРОДАВЕЦ ПИШЕТ, А АГЕНТ НЕ ОТВЕЧАЕТ» (владелец 09.09.2026).
   *
   * Единственная тревога в CRM, которая считает не от обязанности агента
   * действовать, а от его молчания в ответ на клиента. До неё входящее сообщение
   * порождало пуш агенту — и на этом всё: заметить, что на пуш никто не
   * отреагировал, было некому. Пороги: агент на месте — 1 рабочий день, агент
   * отсутствует (больничный, отпуск) — 2. Передачи здесь нет, только уведомление
   * владельцу: клиент остаётся у своего агента. См. lib/agentUnansweredAlarm.ts.
   */
  /**
   * Отпуск с датой выхода снимается сам (lib/absenceReturn.ts). Раз в час хватает:
   * дата выхода — это день, а не минута. Больничный без даты тик не трогает.
   */
  scheduleTracked("absence-return", "5 * * * *", async () => {
    try {
      const { returned } = await runAbsenceReturnTick();
      if (returned > 0) console.log(`[cron] Вышли из отсутствия: ${returned}`);
    } catch (err) {
      reportCronTickError("Ошибка возврата из отсутствия", err);
    }
  });

  /**
   * АВТОПЕРЕДАЧА ЗА МОЛЧАНИЕ УБРАНА 16.09.2026 (владелец, дословно): «Только я могу
   * передавать продавца или покупателя в таких случаях. А не система».
   *
   * Здесь стояла вторая ступень: владелец не решил за сутки — карточка уходила
   * другому агенту сама. Довод был «тревога, которая ничем не заканчивается, —
   * это тревога, которую перестают читать», и он верен для тревог, но не для
   * владения клиентом: отнять карточку у агента — решение о человеке, а не о
   * записи в базе, и цена ошибки здесь не «лишнее уведомление», а несправедливость.
   * Тик, файл lib/unansweredAutoTransfer.ts и его тесты удалены целиком — оставить
   * выключенный механизм значит однажды его случайно включить.
   *
   * Что осталось вместо него: уведомление владельцу (lib/agentUnansweredAlarm.ts)
   * со ссылкой, открывающей окно передачи. Передаёт человек, одним нажатием.
   */

  scheduleTracked("agent-unanswered-alarm", "0 * * * *", async () => {
    try {
      const { alerted } = await runAgentUnansweredAlarmTick();
      if (alerted > 0) console.log(`[cron] Продавец не может связаться с агентом: ${alerted}`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «агент не отвечает продавцу»", err);
    }
  });

  /**
   * «БОТ НА ПАУЗЕ И ЗАБЫЛИ» (Пачка 17, 12.09.2026, lib/botPauseWatch.ts). Раз в
   * час: диалог стоит на паузе, клиент ждёт ответа человека дольше
   * `botPauseAlertHours` — пуш агенту (не чаще раза в сутки), дольше
   * `botPauseEscalateHours` — пауза снимается сама и уходит пуш руководству.
   */
  scheduleTracked("bot-pause-watch", "20 * * * *", async () => {
    try {
      const { alerted, escalated } = await runBotPauseWatchTick();
      if (alerted > 0 || escalated > 0) {
        console.log(`[cron] Бот на паузе и забыли: напомнили ${alerted}, сняли паузу ${escalated}`);
      }
    } catch (err) {
      reportCronTickError("Ошибка «бот на паузе и забыли»", err);
    }
  });

  /**
   * АЛАРМ «ЗАЯВЛЕНО N, СДЕЛАНО M» — ПРОДАВЕЦ И ПОКУПАТЕЛЬ, ОДНО УВЕДОМЛЕНИЕ НА
   * КЛИЕНТА (владелец 06.09.2026 п.3, объединено 07.09.2026, срок растянут по
   * числу объектов 07.09.2026). Число ИИ услышал из разговора или переписки
   * (sellerDeclaredPropertyCount / buyerDesiredPropertyCount) — если срок
   * (2 дня на объект продавцу, 5 дней на объект покупателю) истёк, а в CRM
   * меньше добавленных объектов/закрытых сделок, чем заявлено, директору
   * уходит ОДНО уведомление на клиента с перечислением всех активных
   * расхождений. См. lib/clientPropertyCountAlarm.ts.
   */
  scheduleTracked("client-property-count-alarm", "0 * * * *", async () => {
    try {
      const { alerted } = await runClientPropertyCountAlarmTick();
      if (alerted > 0) console.log(`[cron] Аларм «заявлено/сделано объектов»: ${alerted}`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «заявлено/сделано объектов»", err);
    }
  });

  /**
   * «АГЕНТ, ПОХОЖЕ, УВЁЛ КЛИЕНТА В ОБХОД CRM» (владелец 07.09.2026): спросил
   * номер телефона и после этого либо тишина 2+ дня, либо брошенная встреча/
   * показ без исхода и без переноса. Перед алармом — ИИ проверяет, не объяснил
   * ли сам клиент паузу; если да, аларма нет. См. lib/agentOffCrmAlarm.ts.
   */
  scheduleTracked("agent-off-crm-alarm", "0 * * * *", async () => {
    try {
      const { alerted, skipped } = await runAgentOffCrmAlarmTick();
      if (alerted > 0) console.log(`[cron] Аларм «в обход CRM»: ${alerted} (объяснено и пропущено: ${skipped})`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «в обход CRM»", err);
    }
  });

  /**
   * ПУШ РУКОВОДСТВУ ПО ПРОСРОЧКАМ — ОТДЕЛЬНО ОТ АГЕНТСКОЙ СТОРОНЫ, В ЧАСЫ
   * АЛАРМОВ (владелец 07.09.2026). Раньше уходил ИЗНУТРИ notifyMissedShowings/
   * notifyOverdueTasks/notifyOverdueSummaries тем же пушем и тем же гейтом
   * (рабочие часы АГЕНТА), что и пуш самому агенту. Штраф Royal Score и пуш
   * агенту остаются на прежнем 5-минутном тике — не трогаем KPI-начисление.
   */
  /**
   * ОБЩАЯ ОЧЕРЕДЬ АЛАРМОВ РУКОВОДСТВУ (владелец 07.09.2026) — разбирает всё,
   * что за это время накопил lib/directorAlertQueue.ts::enqueueDirectorAlert
   * (заявки на удаление, антифрод, ночные финансовые/рекламные крон-джобы,
   * просроченные ключи и т.д. — см. список мест в комментарии самого модуля).
   * Каждые 10 минут, а не раз в час: как только откроются часы алармов,
   * накопленное за ночь не должно ждать ещё почти час до следующего тика.
   */
  scheduleTracked("director-alert-queue-flush", "*/10 * * * *", async () => {
    try {
      const sent = await flushDirectorAlertQueue();
      if (sent > 0) console.log(`[cron] Очередь алармов руководству: доставлено ${sent}`);
    } catch (err) {
      reportCronTickError("Ошибка очереди алармов руководству", err);
    }
  });

  scheduleTracked("supervisor-overdue-digest", "0 * * * *", async () => {
    try {
      const notified = await notifySupervisorsOfOverdue();
      if (notified) console.log(`[cron] Руководству о просрочках (показы/встречи/задачи): ${notified}`);
    } catch (err) {
      reportCronTickError("Ошибка сборщика просрочек для руководства", err);
    }
  });

  /**
   * «ПОКУПАТЕЛЬ ДУМАЕТ» — АВТО-ПОДСТРАХОВКА (владелец 30.08.2026) — та же частота:
   * см. lib/buyerThinkingSlowTrack.ts. Включается только для задач, заведённых без
   * выбора агента — его собственный выбор даты этот тик не трогает вовсе.
   */
  scheduleTracked(
    "buyer-thinking-slow-track",
    "*/30 * * * *",
    async () => {
      try {
        const { advanced } = await runBuyerThinkingSlowTrackTick();
        if (advanced > 0) console.log(`[cron] Покупатель думает: продвинуто задач ${advanced}`);
      } catch (err) {
        reportCronTickError("Ошибка медленного трека «думает»", err);
      }
    },
    undefined,
    undefined,
    // Инцидент 11-12.09: до 800 круговых запросов к БД за прогон насыщали пул
    // в час пик (09:30 Душанбе) — тик зависал, следующие срабатывания терялись
    // молча. Явный таймаут снимает замок, не дожидаясь MAX_TICK_TIMEOUT_MS (20 мин).
    { timeoutMs: 5 * 60_000 }
  );

  /**
   * «ХВОСТ» ДОЗВОНА (01.09.2026, Settings.noAnswerTail*) — та же частота, что у
   * соседних лёгких тиков выше: маячков в выборке за раз немного (см. take: 200 в
   * processNoAnswerTailAnchors), гонять чаще незачем — задача агенту всё равно
   * рассчитана на дни, а не минуты.
   */
  scheduleTracked(
    "no-answer-tail",
    "*/30 * * * *",
    async () => {
      try {
        const created = await processNoAnswerTailAnchors();
        if (created > 0) console.log(`[cron] Хвост дозвона: заведено задач ${created}`);
      } catch (err) {
        reportCronTickError("Ошибка хвоста дозвона", err);
      }
    },
    undefined,
    undefined,
    // Тот же инцидент 11-12.09, что и у buyer-thinking-slow-track — оба тика
    // делали до 200 последовательных findUnique/count на строку.
    { timeoutMs: 5 * 60_000 }
  );

  /**
   * ЭСКАЛАЦИЯ ПРОПУЩЕННЫХ РУКОВОДСТВУ УДАЛЕНА (владелец 20.09.2026: «полностью
   * удали пуш и эскалацию руководителю, нам это не нужно»). Была заведена
   * Пачкой 18 (12.09.2026) и слала руководству две ступени — про безхозный
   * номер и про агента, не перезвонившего за N рабочих часов.
   *
   * Пропущенные никуда не делись: агент получает ОДИН пуш в момент самого
   * звонка (lib/telephony/incomingCalls.ts, notifyMissed) и задачу перезвонить
   * в хронологии, а сколько вчерашних пропущенных до сих пор без перезвона —
   * видно в утренних числах (countMissedCallsNoCallbackYesterday).
   */

  /**
   * АЛАРМ ДИРЕКТОРУ «ПОКУПАТЕЛЬ АКТИВЕН, НЕТ ЗВОНКА N ДНЕЙ» (требование 6, аудит 02.09.2026).
   * Ежечасный тик: покупатели ACTIVE + kind=BUYER + aiScore>=70 + нет звонка через CRM ≥2 дн.
   * Дедуп через tag в Notification — повторный тик того же клиента не создаёт нового пуша.
   * См. lib/buyerNoCallAlarm.ts.
   */
  scheduleTracked("buyer-no-call-alarm", "0 * * * *", async () => {
    try {
      const { alerted } = await runBuyerNoCallAlarmTick();
      if (alerted > 0) console.log(`[cron] Аларм «нет звонка»: отправлено директору ${alerted}`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «нет звонка»", err);
    }
  });

  /**
   * ОЧЕРЕДЬ АЛАРМА «ОТКАЗ ПРИ ВЫСОКОМ СКОРИНГЕ» (владелец 07.09.2026): само
   * событие мгновенное (POST /clients/:id/refuse) и раньше слало пуш директору
   * в любой час — теперь только ставит отметку, а этот тик досылает пуш в часы
   * алармов. См. lib/buyerNoCallAlarm.ts::runRefusedHighScoreAlarmTick.
   */
  scheduleTracked("refused-high-score-alarm", "0 * * * *", async () => {
    try {
      const { alerted } = await runRefusedHighScoreAlarmTick();
      if (alerted > 0) console.log(`[cron] Аларм «отказ при высоком скоринге»: ${alerted}`);
    } catch (err) {
      reportCronTickError("Ошибка аларма «отказ при высоком скоринге»", err);
    }
  });

  /**
   * СТОРОЖ «НОМЕР ЕСТЬ — КАРТОЧКИ НЕТ» (ступени 3-4 защиты от потерянных лидов, 03.09.2026).
   * Каждые 15 минут: свежие переписки без карточки, в которых клиент оставил номер.
   * Ловит ФАКТ потери независимо от причины — в том числе те, которых мы ещё не знаем.
   * Что можно — оформляет сам тем же приёмом, что и живое сообщение; человека зовёт
   * только там, где решение за человеком (нечитаемый номер, рассылка, отказ приёма).
   * Дедуп по tag: один диалог = одно уведомление. См. lib/phoneLeadWatchdog.ts.
   */
  scheduleTracked("phone-lead-watchdog", "*/15 * * * *", async () => {
    try {
      const { alerted, accepted, attached } = await runPhoneLeadWatchdogTick();
      if (accepted > 0) console.log(`[cron] Лиды без карточки: заявок оформлено ${accepted}`);
      if (attached > 0) console.log(`[cron] Лиды без карточки: диалогов привязано к известным клиентам ${attached}`);
      if (alerted > 0) console.log(`[cron] Лиды без карточки: сигналов руководству ${alerted}`);
      if (attached > 0) console.log(`[cron] Лиды без карточки: диалогов автопривязано к известным клиентам ${attached}`);
    } catch (err) {
      reportCronTickError("Ошибка сторожа лидов без карточки", err);
    }
  });

  /**
   * РАЗДЕЛ L, УРОВЕНЬ 4 (03.09.2026, план вечерней сессии §L) — ежедневный проактивный
   * скан вероятных дублей по всей базе (похожее имя + похожий номер). Раз в день, а не
   * чаще — сигнал слабый, и «Клиенты → Дубликаты» и так открыт на живом запросе в любой
   * момент (GET /clients/duplicates, reason:"nameAndPhone") — крон только толкает
   * руководителя, чтобы раздел не забывали открывать. 08:00 по Душанбе — до начала
   * рабочего дня, дедуп по паре id (см. lib/duplicateReview.ts) не даёт повторяться.
   */
  scheduleTracked(
    "duplicate-fuzzy-scan",
    "0 8 * * *",
    async () => {
      try {
        const { found } = await runDuplicateFuzzyScanTick();
        if (found > 0) console.log(`[cron] Вероятных дублей по имени/номеру: ${found}`);
      } catch (err) {
        reportCronTickError("Ошибка ночного скана дублей", err);
      }
    },
    // Без пояса node-cron берёт время процесса, а контейнер живёт в UTC: скан
    // уходил в 13:00 по Душанбе — в разгар дня вместо обещанного комментарием
    // «до начала рабочего дня». Соседний morning-report на том же «0 8 * * *»
    // пояс задаёт с самого начала. Сторож правила — tests/cron-timezone.test.ts.
    { timezone: "Asia/Dushanbe" }
  );

  /** Ежедневный пересчёт KPI агентов за ВЧЕРА — 00:05 по Душанбе (даём Дисциплине/SLA
   *  минуту "остыть" после полуночи, чтобы день точно был закрыт целиком). */
  scheduleTracked(
    "daily-kpi",
    "5 0 * * *",
    async () => {
      try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const n = await calculateDailyKpiForAllAgents(yesterday);
        console.log(`[cron] KPI пересчитан за вчера: ${n} агентов`);
      } catch (err) {
        reportCronTickError("Ошибка пересчёта KPI", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ЗАСТОЙ СДЕЛКИ (пункт 4 списка владельца 30.08.2026) — 00:20 по Душанбе, сразу
   * после пересчёта KPI. Не срочный сигнал — раз в сутки достаточно, см.
   * lib/dealStalePipeline.ts: продавец без единого объекта / покупатель без
   * единой сделки дольше настраиваемого числа дней получает пуш руководству и
   * задачу ведущему агенту, один раз на клиента (dealStaleEscalatedAt).
   */
  scheduleTracked(
    "deal-stale-pipeline",
    "20 0 * * *",
    async () => {
      try {
        const { sellersEscalated, buyersEscalated } = await runDealStalePipeline();
        if (sellersEscalated || buyersEscalated) {
          console.log(`[cron] Застой сделки: продавцов ${sellersEscalated}, покупателей ${buyersEscalated}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка проверки застоя сделки", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * МОЛЧАЛИВЫЙ КЛИЕНТ → АВТОМАТИЧЕСКИ В НЕАКТИВНЫЕ (владелец 30.08.2026) —
   * 00:25 по Душанбе, следом за застоем сделки. Не срочный сигнал — раз в
   * сутки достаточно, см. lib/silentClientAutoDeactivate.ts: клиент, чьё
   * последнее слово в переписке с ботом было НАШИМ (бот или агент) дольше
   * Settings.silentClientInactiveDays дней, уходит в Неактивные тем же путём,
   * что и ручной перевод (workStatus, светофор RED/STOPPED_RESPONDING), без
   * пуша — светофор напомнит по своему обычному расписанию.
   */
  scheduleTracked(
    "silent-client-auto-deactivate",
    "25 0 * * *",
    async () => {
      try {
        const { deactivated } = await runSilentClientAutoDeactivate();
        if (deactivated) console.log(`[cron] Молчаливых клиентов переведено в Неактивные: ${deactivated}`);
      } catch (err) {
        reportCronTickError("Ошибка автоперевода молчаливых клиентов", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * «ПОТЕРЯННЫЕ» И «НЕАКТИВНЫЕ» СТАРШЕ 3 МЕСЯЦЕВ → АВТОМАТИЧЕСКИ В КОРЗИНУ
   * (владелец 30.08.2026) — 00:30 по Душанбе, следом за автопереводом
   * молчаливых. Не срочный сигнал — раз в сутки достаточно, см.
   * lib/lostInactiveTrashSweep.ts: обычное мягкое удаление (trashClient),
   * восстановимо повторным обращением клиента (см. leads.ts::resumeExistingChannelLead).
   */
  scheduleTracked(
    "lost-inactive-trash-sweep",
    "30 0 * * *",
    async () => {
      try {
        const { trashed, skipped } = await runLostInactiveTrashSweep();
        if (trashed || skipped) {
          console.log(`[cron] Автоуборка Потерянных/Неактивных в Корзину: убрано ${trashed}, пропущено ${skipped}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка автоуборки Потерянных/Неактивных в Корзину", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Месячный отчёт руководству — 1-го числа в 09:00 по Душанбе, за прошедший месяц.
   *  Не в полночь: отчёт нужен человеку в начале рабочего дня, а не push в три часа
   *  ночи. Идемпотентно — повторный запуск в тот же месяц ничего не дублирует и не
   *  трогает заметки владельца. */
  scheduleTracked(
    "monthly-report",
    "0 9 1 * *",
    async () => {
      try {
        const { created, periodStart } = await generateMonthlyReport();
        if (created) console.log(`[cron] Месячный отчёт составлен за ${dushanbeWallClock(periodStart).toISOString().slice(0, 7)}`);
      } catch (err) {
        reportCronTickError("Ошибка месячного отчёта", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Курс USD→TJS с alif.tj — раз в сутки, ночью по Душанбе. Правится и вручную в
   *  Настройках в любой момент; этот job лишь освежает его официальным значением,
   *  если директор сам не переопределил (следующий automatic-тик всё равно перезапишет
   *  ручную правку — так и задумано, "официальный курс по умолчанию"). */
  scheduleTracked(
    "exchange-rate",
    "0 1 * * *",
    async () => {
      // try/catch обязателен, как у всех тиков: сам fetch курса не бросает, а вот
      // запись в Settings ночью может (обрыв базы) — без обёртки reject уходил в
      // unhandledRejection мимо журнала, и курс молча оставался вчерашним.
      try {
        const result = await refreshUsdToTjsRateFromAlif();
        if (result.ok) {
          console.log(`[cron] Курс USD→TJS обновлён с alif.tj: ${result.rate}`);
        } else {
          // Курс молча остаётся вчерашним, а по нему считаются комиссия и Финансы —
          // отказ обязан быть виден на «Здоровье системы», а не только в логах контейнера.
          markCronTickFailed("Курс USD→TJS", result.error);
          void logSystemError("exchange-rate", `Курс USD→TJS не обновлён: ${result.error}`);
        }
      } catch (err) {
        const reason = markCronTickFailed("Курс USD→TJS", err);
        void logSystemError("exchange-rate", `Курс USD→TJS не обновлён: ${reason}`);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Маркер Instagram живёт 60 дней. Проверяем каждую ночь, продлеваем раз в неделю
   *  (см. instagramFeed.ts) — иначе он тихо умирает, и разом пропадают и ответы в
   *  директ, и лента на главной сайта. Отказ не критичен: попробуем следующей ночью. */
  scheduleTracked(
    "token-and-finance-daily",
    "20 1 * * *",
    async () => {
      /**
       * СВОЙ try/catch НА КАЖДУЮ ЗАДАЧУ (26.08.2026). Семь задач жили под одним:
       * исключение в ранней (скажем, upsertAiExpenses) молча отменяло зарплатные
       * строки, напоминания о платежах, прогноз перерасхода и сигналы рекламы до
       * следующей ночи — при том что сам файл в двух местах формулирует правило
       * «общий try/catch означал бы, что сбой одной сверки отменяет вторую»
       * (тики 04:50 и 03:30). Вдобавок любой сбой печатался как «Ошибка продления
       * маркера Instagram», даже если упал checkAdAlerts. Финансовые сбои — в журнал.
       */
      const step = async (label: string, kind: SystemErrorSource, run: () => Promise<void>) => {
        try {
          await run();
        } catch (err) {
          const reason = markCronTickFailed(label, err);
          void logSystemError(kind, `${label}: ${reason}`);
        }
      };
      await step("Продление маркера Instagram не удалось", "meta", async () => {
        // Функция сама решает, ЧЕЙ маркер продлить (копия в Settings и каждая строка
        // MessengerAccount — независимо, см. instagramFeed.ts) и сама же пишет отказ
        // каждого источника в журнал с его именем; здесь только итог тика для лога крона.
        const { refreshed, failed } = await refreshInstagramTokenIfDue();
        if (refreshed > 0 || failed > 0) {
          console.log(`[cron] Маркеры Instagram: продлено ${refreshed}, не продлилось ${failed}`);
        }
      });
      // Threads: тем же приёмом, что Instagram выше — продлить, пока токен
      // жив (см. докстринг refreshThreadsTokenIfDue в lib/socialPublish.ts:
      // 60 дней без использования, и он умирает навсегда).
      await step("Продление токена Threads не удалось", "threads", async () => {
        const { refreshed, failed } = await refreshThreadsTokenIfDue();
        if (refreshed > 0 || failed > 0) {
          console.log(`[cron] Токен Threads: продлено ${refreshed}, не продлилось ${failed}`);
        }
      });
      // YouTube: продлевать нечего (refresh-токен выдаётся вручную через
      // consent-flow), но узнавать о его смерти надо не в момент публикации
      // ролика, а сразу — иначе объект «опубликован» в CRM и не опубликован на
      // канале. Обмен refresh→access ничего не заливает и квоту не тратит.
      await step("Проверка доступа к YouTube не выполнена", "youtube", async () => {
        const alive = await checkYouTubeTokenHealth();
        if (alive === true) console.log("[cron] Доступ к YouTube жив");
      });
      // Остальные внешние доступы — тем же приёмом и тем же тиком. Карта класса
      // «протух доступ, а узнаём в момент использования» и почему каждый из них
      // ломается тихо — в lib/integrationHealth.ts и docs/TASKS.md (11.09.2026).
      // Свой step: сбой обхода не должен отменять финансовые сверки ниже.
      await step("Суточная проверка внешних доступов не выполнена", "cron", async () => {
        const checks = await runIntegrationHealthChecks();
        const broken = checks.filter((c) => c.ok === false).map((c) => c.name);
        const alive = checks.filter((c) => c.ok === true).length;
        console.log(
          `[cron] Внешние доступы: живых ${alive}, сломанных ${broken.length}` +
            (broken.length ? ` (${broken.join(", ")})` : "")
        );
        // Снимок для экрана /integrations (перенос мобильного макета 14.09.2026,
        // шаг 5) — раньше результат нигде не оставался, кроме консоли и ErrorLog
        // при отказе; upsert по имени канала, старый снимок просто перезаписан.
        // Отдельный try/catch: отказ записи снимка не должен красить этот шаг
        // тика неудачным — сама проверка уже выполнена и залогирована выше.
        try {
          await Promise.all(
            checks.map((c) =>
              prisma.integrationHealthSnapshot.upsert({
                where: { name: c.name },
                create: { name: c.name, ok: c.ok, detail: c.detail },
                update: { ok: c.ok, detail: c.detail },
              })
            )
          );
        } catch (err) {
          reportCronTickError("снимок внешних доступов не сохранён", err);
        }
      });
      // Маркер рекламного кабинета живёт те же 60 дней и умирает так же молча —
      // продлеваем рядом, тем же суточным тиком (сам решит, пора ли).
      await step("Продление маркера рекламного кабинета не удалось", "meta", async () => {
        if (await refreshMetaAdsTokenIfDue()) console.log("[cron] Маркер рекламного кабинета продлён");
      });
      // Маркер удаления Instagram и маркер Страницы (Facebook Login): пользовательский маркер
      // со сроком меньше трёх недель обмениваем на новый 60-дневный, бессрочные не трогаем.
      await step("Продление маркеров Facebook Login не удалось", "meta", async () => {
        const { refreshed } = await refreshMetaUserTokensIfDue();
        if (refreshed.length > 0) console.log(`[cron] Маркеры продлены: ${refreshed.join(", ")}`);
      });
      // Финансы: строка «расходы на ИИ за месяц» из журнала обращений — раз в
      // сутки, вместе с остальными суточными сверками (lib/ads/adExpenseSync.ts).
      await step("Расходы на ИИ не обновлены", "api", async () => {
        const aiRows = await upsertAiExpenses(recentMonths(2));
        if (aiRows) console.log(`[cron] Расходы на ИИ обновлены (${aiRows} мес.)`);
      });
      // Повторяющиеся платежи: напоминание за 3 дня, строка в день оплаты.
      await step("Повторяющиеся платежи не обработаны", "api", async () => {
        const rec = await processRecurringExpenses();
        if (rec.created || rec.reminded) {
          console.log(`[cron] Повторяющиеся платежи: строк ${rec.created}, напоминаний ${rec.reminded}`);
        }
      });
      // Зарплаты из закрытых сделок прошлого месяца (autoKey — идемпотентно).
      await step("Зарплатные строки не обновлены", "api", async () => {
        const salaries = await upsertSalaryExpenses();
        if (salaries) console.log(`[cron] Зарплатных строк обновлено: ${salaries}`);
      });
      // Прогноз перерасхода и сигналы рекламы — НЕ здесь (04.09.2026): оба
      // толкают пуш директору/маркетингу, а этот тик — 01:20 ночи. Считаются
      // отдельным дневным тиком ниже (working-hours-daily-alerts), чтобы не
      // будить руководство ночью (решение владельца «3б»). Расчёт остаётся
      // суточным — только МОМЕНТ уведомления сдвинут на утро.
    },
    { timezone: "Asia/Dushanbe" }
  );

  /**
   * ДНЕВНЫЕ ФИНАНСОВЫЕ/РЕКЛАМНЫЕ СИГНАЛЫ ДИРЕКТОРУ (04.09.2026, решение
   * владельца «3б»: «все алармы и уведомления руководителя — в рабочий день и
   * час»). Раньше alertExpenseOverrun/checkAdAlerts вызывались внутри
   * token-and-finance-daily в 01:20 ночи вместе с расчётами, которым время
   * суток не важно (продление токена, ETL расходов) — director/marketing пуш
   * будил их в час ночи. Сам расчёт по-прежнему суточный (обе функции хранят
   * собственный дневной/месячный дедуп — lastAlertDay, overrunAlertedMonth —
   * и не отправят второй раз за день/месяц); сдвинут только МОМЕНТ показа
   * пуля на 9:35 — после сводки СБ (9:20) и инсайт-диджеста (9:00), чтобы не
   * складывать тяжёлые утренние тики в одну минуту.
   */
  scheduleTracked(
    "working-hours-daily-alerts",
    "35 9 * * *",
    async () => {
      try {
        if (await alertExpenseOverrun()) console.log("[cron] Отправлено предупреждение о перерасходе");
      } catch (err) {
        markCronTickFailed("Прогноз перерасхода не посчитан", err);
        void logSystemError("api", `Прогноз перерасхода не посчитан: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const adAlerts = await checkAdAlerts();
        if (adAlerts) console.log(`[cron] Сигналов рекламы отправлено: ${adAlerts}`);
      } catch (err) {
        markCronTickFailed("Сигналы рекламы не проверены", err);
        void logSystemError("meta", `Сигналы рекламы не проверены: ${err instanceof Error ? err.message : String(err)}`);
      }
      /**
       * Волна 1 «Реклама» (03.10.2026): отклонённые объявления и состояние кабинета
       * (долг, платёж, лимит, статус). Дедупликация — в базе (shouldAlert по tag),
       * а не в памяти процесса, поэтому рестарт API после выката не даёт второго
       * пакета. Каждая проверка в своём try: упавший кабинет Meta не должен
       * гасить сигнал об отклонённом объявлении.
       */
      try {
        const disapproved = await checkAdDisapprovedAlerts();
        if (disapproved) console.log(`[cron] Уведомлений об отклонённой рекламе: ${disapproved}`);
      } catch (err) {
        markCronTickFailed("Отклонённые объявления не проверены", err);
        void logSystemError("meta", `Отклонённые объявления не проверены: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const accountAlerts = await checkAdAccountAlerts();
        if (accountAlerts) console.log(`[cron] Тревог по рекламному кабинету: ${accountAlerts}`);
      } catch (err) {
        markCronTickFailed("Состояние рекламного кабинета не проверено", err);
        void logSystemError("meta", `Состояние рекламного кабинета не проверено: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );

  /** Комментарии под публикациями Instagram — каждую минуту. Часто, потому что
   *  отвечать надо через 1-2 минуты после комментария: мгновенный ответ выдаёт
   *  робота, а ответ через полчаса под живым постом уже никому не нужен.
   *  isCommentsRunning — тот же гвард, что у напоминаний: проход делает вызов ИИ и
   *  запросы в Graph API на каждый комментарий и легко перекрывает минуту, а два
   *  прохода на одной записи означали бы два публичных ответа подряд. */
  let isCommentsRunning = false;
  scheduleTracked(
    "instagram-comments",
    "* * * * *",
    async () => {
      if (isCommentsRunning) return;
      isCommentsRunning = true;
      try {
        const { replied, hidden, escalated } = await processDueComments();
        if (replied || hidden || escalated) {
          console.log(`[cron] Комментарии Instagram: ответов ${replied}, скрыто ${hidden}, эскалаций ${escalated}`);
        }
      } catch (err) {
        reportCronTickError("Ошибка разбора комментариев Instagram", err);
      } finally {
        isCommentsRunning = false;
      }
    },
    undefined,
    undefined,
    /**
     * СВОЙ ТАЙМАУТ ВМЕСТО ДЕФОЛТНОГО 2×ИНТЕРВАЛ (22.09.2026, ежедневная запись
     * «не завершил тик за 2 мин» в журнале крона). Тик по умолчанию получал
     * intervalMs*2 = 2 минуты (расписание "* * * * *" = раз в минуту), а
     * processDueComments честно ждёт human-паузу (60-120с, humanReplyDelay)
     * ПЕРЕД каждой публикацией, разбирая до BATCH_LIMIT комментариев волнами по
     * COMMENT_CONCURRENCY=8 (messengers/comments.ts) — то есть тик почти
     * ГАРАНТИРОВАННО не укладывался в 2 минуты уже при паре комментариев в
     * очереди, и сторож писал в журнал то, что было не сбоем, а нормальной
     * работой на срезанном таймауте. BATCH_LIMIT заодно снижен (30 → 16, см.
     * comments.ts): меньше волн — короче худший случай одного тика, а бот
     * никуда не денется: следующий тик (через минуту) подберёт остаток.
     * 12 минут — с запасом на две волны по 16/8=2, каждая до ~5 минут (пауза
     * 120с + вызов ИИ + Graph API с ретраями), и всё ещё меньше потолка
     * MAX_TICK_TIMEOUT_MS (20 мин).
     */
    { timeoutMs: 12 * 60_000 }
  );

  /**
   * Комментарии под YouTube Shorts (17.09.2026) — своя запись, а не внутри
   * instagram-comments: у YouTube нет вебхука, поэтому это ОПРОС (см.
   * youtubeComments.ts::pollYouTubeComments), и разумный ритм для него не «раз в
   * минуту», а раз в 2 минуты — 1 единица квоты commentThreads на тик, 720/день из
   * 10 000 дневного лимита. Разбор самой очереди (processDueComments) общий с
   * Instagram/Facebook, второй раз его звать здесь не нужно — тик крона выше уже
   * разбирает все каналы разом.
   */
  let isYoutubeCommentsRunning = false;
  scheduleTracked("youtube-comments", "*/2 * * * *", async () => {
    if (isYoutubeCommentsRunning) return;
    isYoutubeCommentsRunning = true;
    try {
      await pollYouTubeComments();
    } catch (err) {
      reportCronTickError("Ошибка опроса комментариев YouTube", err);
    } finally {
      isYoutubeCommentsRunning = false;
    }
  });

  /** Комментарии в группе-обсуждении Telegram-канала — тот же ритм и та же причина
   *  для гварда, что у instagram-comments выше (см. messengers/telegramGroupComments.ts). */
  let isTelegramCommentsRunning = false;
  scheduleTracked("telegram-group-comments", "* * * * *", async () => {
    if (isTelegramCommentsRunning) return;
    isTelegramCommentsRunning = true;
    try {
      const { replied, hidden, escalated } = await processDueTelegramComments();
      if (replied || hidden || escalated) {
        console.log(`[cron] Комментарии Telegram: ответов ${replied}, удалено ${hidden}, эскалаций ${escalated}`);
      }
    } catch (err) {
      reportCronTickError("Ошибка разбора комментариев Telegram", err);
    } finally {
      isTelegramCommentsRunning = false;
    }
  });

  /** Напоминания клиентам, переставшим отвечать — каждые 10 минут. Часто, потому что
   *  попытка «через час» должна уходить примерно через час, а не через полтора.
   *  isRemindersRunning — тот же гвард, что у распределения лидов: проход делает вызов
   *  ИИ и отправку на каждый диалог (до 200 за раз) и легко переваливает за интервал,
   *  а счётчик попыток растёт только ПОСЛЕ отправки — без гварда следующий тик брал
   *  те же диалоги и клиент получал два напоминания подряд. */
  let isRemindersRunning = false;
  scheduleTracked("client-follow-ups", "*/10 * * * *", async () => {
    if (isRemindersRunning) return;
    isRemindersRunning = true;
    try {
      const sent = await sendFollowUps();
      if (sent > 0) console.log(`[cron] Напоминаний клиентам отправлено: ${sent}`);
    } catch (err) {
      reportCronTickError("Ошибка напоминаний клиентам", err);
    } finally {
      isRemindersRunning = false;
    }
  });

  /**
   * ПРОСЬБА О НОМЕРЕ У КАНДИДАТОВ — КАЖДЫЕ 15 МИНУТ (владелец 03.09.2026:
   * «сделай, чтобы бот сам просил номер, когда окно откроется»).
   *
   * Анкета без телефона в очередь CRM не идёт: звонить такому кандидату нечем.
   * Написать ему можно только внутри 24 часов с его последней реплики — правило
   * Meta, и на первом прогоне четверо из девяти оказались за этой границей.
   * Окно открывается в тот момент, когда человек напишет снова, и угадать его
   * нельзя: поэтому очередь просматривается по расписанию, а не руками.
   *
   * Тик дешёвый: выборка — только анкеты без номера, которых ещё не просили,
   * а вызов ИИ случается лишь для тех, кому реально отправляем. Гвард от
   * наложения обязателен по той же причине, что у напоминаний: отметка
   * ставится ПОСЛЕ отправки, и без гварда соседний тик написал бы второй раз.
   */
  let isCandidatePhoneAskRunning = false;
  scheduleTracked("candidate-phone-ask", "*/15 * * * *", async () => {
    if (isCandidatePhoneAskRunning) return;
    isCandidatePhoneAskRunning = true;
    try {
      const r = await askCandidatePhone({ apply: true, limit: 50 });
      if (r.sent > 0) console.log(`[cron] Просьб о номере кандидатам отправлено: ${r.sent}`);
    } catch (err) {
      reportCronTickError("Ошибка просьбы о номере", err);
    } finally {
      isCandidatePhoneAskRunning = false;
    }
  });

  /** Сторож пульса: тик, молчащий дольше 2× своего интервала, поднимает
   *  logSystemError (см. lib/cronHeartbeat.ts). Сам сторож — такой же тик,
   *  его пульс виден в той же таблице. */
  scheduleTracked("heartbeat-watchdog", "*/15 * * * *", async () => {
    try {
      const alerts = await checkCronHeartbeats();
      if (alerts) console.log(`[cron] Сторож пульса: тревог поднято ${alerts}`);
    } catch (err) {
      reportCronTickError("Ошибка сторожа пульса", err);
    }
  });

  // The ordinary durable queue still handles media once a minute. Customer
  // model turns and sends have separate bounded slots; both use runOne, DB
  // SKIP LOCKED, normal retry policy and existing provider UNKNOWN guards.
  scheduleTracked("customer-inbox-jobs", "*/5 * * * * *", async () => {
    await runCustomerJobsTick("inbox");
  }, undefined, undefined, { timeoutMs: 20 * 60_000 });
  scheduleTracked("customer-outbox-jobs", "*/5 * * * * *", async () => {
    await runCustomerJobsTick("outbox");
  }, undefined, undefined, { timeoutMs: 20 * 60_000 });
  scheduleTracked("customer-intake-jobs", "*/5 * * * * *", async () => {
    await runCustomerJobsTick("intake");
  }, undefined, undefined, { timeoutMs: 20 * 60_000 });

  /** Очередь фоновых заданий (jobs/runner.ts, чертёж §2): минутный тик хватает
   *  партию PENDING + подбирает зависшие RUNNING. Гвард от наложения обязателен:
   *  партия с ffmpeg-джобами легко живёт дольше минуты. */
  let isBackgroundJobsTickRunning = false;
  scheduleTracked(
    "background-jobs",
    "* * * * *",
    async () => {
      if (isBackgroundJobsTickRunning) return;
      isBackgroundJobsTickRunning = true;
      try {
        const done = await runBackgroundJobsTick();
        if (done) console.log(`[cron] Заданий очереди исполнено: ${done}`);
      } catch (err) {
        markCronTickFailed("Ошибка тика очереди заданий", err);
        void logSystemError("background-jobs", `Тик очереди заданий упал: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        isBackgroundJobsTickRunning = false;
      }
    },
    undefined,
    undefined,
    /**
     * СВОЙ ТАЙМАУТ (22.09.2026). Дефолт intervalMs*2 = 2 минуты — партия
     * исполняется ПОСЛЕДОВАТЕЛЬНО (jobs/runner.ts, BATCH_SIZE=10, до одного
     * ffmpeg-джоба в хвосте) и с 09.09 у каждого задания есть свой таймаут
     * (LIGHT_JOB_TIMEOUT_MS=60с, HEAVY_JOB_TIMEOUT_MS=8мин, см. runner.ts) —
     * честный худший случай партии: 9 лёгких × 60с + 1 тяжёлый × 8мин ≈ 17
     * минут, дефолтные 2 минуты снимали замок на каждой такой партии и писали
     * ложную тревогу. 18 минут — чуть выше худшего случая и ниже потолка
     * MAX_TICK_TIMEOUT_MS (20 мин). С 23.09.2026 повтор хода бота ждёт до
     * 150 с (BOT_TURN_JOB_TIMEOUT_MS): партия из девяти таких, упёршихся в
     * срок, переживёт этот таймаут — но тогда тревога честная, ИИ лежит.
     */
    // 02.10.2026: тяжёлой стала и повторная расшифровка со сроком 10 минут
    // (jobs/transcriptionRetry.ts) — худший случай 9 × 60 с + 10 мин, отсюда потолок.
    { timeoutMs: 20 * 60_000 }
  );

  /** Инсайты от ИИ — 15-е и 30-е число, 09:00 Душанбе. Двухнедельный диджест
   *  находок по звонкам, штрафам и потерям клиентов для собрания директоров.
   *  Рубильник insightDigestEnabled в Settings; при выключенном крон пропускает
   *  сборку, существующие диджесты остаются доступными для чтения. */
  scheduleTracked("insight-digest", "0 9 15,28-31 * *", async () => {
    const settings = await prisma.settings.findFirst();
    if (!settings?.insightDigestEnabled) return;

    // «30-е» в феврале не наступает никогда — крон стоит на 28–31 и сам выбирает
    // день собрания: 30-е, а если в месяце его нет — последний день. Период —
    // от прошлого собрания до этого, без зазора (lib/insightDigestPeriod.ts).
    if (!isInsightMeetingDay()) return;
    const { periodStart, periodEnd, meetingAt } = insightDigestPeriod();

    try {
      const { generateInsightDigest, notifyDirectorsAboutInsightDigest } = await import("./lib/insightDigestRunner.js");
      const digestId = await generateInsightDigest(periodStart, periodEnd, meetingAt);
      if (digestId !== "DISABLED") {
        await notifyDirectorsAboutInsightDigest(digestId);
        console.log(`[cron] Инсайт-диджест сгенерирован: ${digestId}`);
      }
    } catch (err) {
      markCronTickFailed("Ошибка генерации инсайт-диджеста", err);
      void logSystemError("api", `Insight digest cron failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, { timezone: "Asia/Dushanbe" });
}
