import { registerJobHandler } from "./registry.js";
import { geocodeJob } from "./geocode.js";
import { aiReplyRetryJob } from "./aiReplyRetry.js";
import { aiTurnBlockedFollowupJob } from "./aiTurnBlockedFollowup.js";
import { transcriptionRetryJob } from "./transcriptionRetry.js";
import { recordingSearchRetryJob } from "./recordingSearchRetry.js";
import { clipCompressJob } from "./clipCompress.js";
import { siteResyncJob } from "./siteResync.js";
import { dealCloseFollowupJob } from "./dealCloseFollowup.js";
import { clientReactivationJob } from "./clientReactivation.js";
import { dealReviewAskJob } from "./dealReviewAsk.js";
import { deferredPushJob } from "./deferredPush.js";
import { telegramReplyRetryJob } from "./telegramReplyRetry.js";
import { telegramDirectReplyRetryJob } from "./telegramDirectReplyRetry.js";
import { geoMatchSweepJob } from "./geoMatchSweep.js";
import { videoHandoffPublishJob } from "./videoHandoffPublish.js";
import { photoPostPublishJob } from "./photoPostPublish.js";
import { socialRepostPublishJob } from "./socialRepostPublish.js";
import { tiktokPublishRetryJob } from "./tiktokPublishRetry.js";
import { socialVideoPublishJob } from "./socialVideoPublish.js";
import { sellerPhotoInsightJob } from "./sellerPhotoInsight.js";
import { sellerFactsJob } from "./sellerFacts.js";
import { videoOpeningJob } from "./videoOpening.js";
import { customerCallbackNotifyJob } from "./customerCallbackNotify.js";
import { customerIntakePolicyJob } from "./customerIntakePolicy.js";
import { customerIntakeNotifyJob } from "./customerIntakeNotify.js";
import { customerOwnerQuestionNotifyJob } from "./customerOwnerQuestionNotify.js";
import { customerShowingNotifyJob } from "./customerShowingNotify.js";
import { customerInboxConsumeJob } from "./customerInboxConsume.js";
import { customerOutboxDispatchJob } from "./customerOutboxDispatch.js";
import { customerContactIntakeJob } from "./customerContactIntake.js";

/**
 * Все обработчики очереди — одним списком. Импортируется ТОЛЬКО runner'ом
 * (worker-процесс): HTTP-процесс ставит задания, не зная обработчиков
 * (см. докстринг registry.ts про разрыв цикла импортов).
 */
registerJobHandler(geocodeJob);
registerJobHandler(aiReplyRetryJob);
registerJobHandler(aiTurnBlockedFollowupJob);
registerJobHandler(transcriptionRetryJob);
// Догоняющий поиск файла записи после отвеченного разговора (владелец 20.09.2026).
registerJobHandler(recordingSearchRetryJob);
registerJobHandler(clipCompressJob);
registerJobHandler(siteResyncJob);
registerJobHandler(dealCloseFollowupJob);
registerJobHandler(clientReactivationJob);
registerJobHandler(dealReviewAskJob);
// Пуш, отложенный тихими часами до 08:00 (владелец 12.09.2026).
registerJobHandler(deferredPushJob);
registerJobHandler(telegramReplyRetryJob);
registerJobHandler(telegramDirectReplyRetryJob);
// Ночной проход гео-подбора, страховка (владелец 12.09.2026, блок E плана).
registerJobHandler(geoMatchSweepJob);
// Публикация ролика от монтажёра (случай №114, 21.09.2026) — пять сетей,
// минуты; выживает рестарт контейнера, чего не умел синхронный вызов.
registerJobHandler(videoHandoffPublishJob);
// Фото-посты для объектов без ролика (28.09.2026) — та же схема очереди, что у
// видео-конвейера, payload {propertyId}.
registerJobHandler(photoPostPublishJob);
// Повторный показ объекта (28.09.2026, agent-brief.md reposts-digests) — та же
// схема очереди, что у фото-постов, payload {propertyId, round}.
registerJobHandler(socialRepostPublishJob);
// Повтор публикации в TikTok, когда сам TikTok попросил подождать (23.09.2026).
registerJobHandler(tiktokPublishRetryJob);
// Публикация свободного (без объекта) ролика в выбранные соцсети (12.10.2026).
registerJobHandler(socialVideoPublishJob);
// Оценка фото продавца из переписки (21.09.2026, agent-brief.md §5) — кэш по
// sha256, один vision-вызов на пачку новых снимков, ставится вместе с разбором
// фактов (lib/sellerMedia.ts::scheduleSellerPhotoInsights).
registerJobHandler(sellerPhotoInsightJob);
// Факты об объекте продавца из переписки и звонков (владелец 21.09.2026) —
// фоном с дребезгом 15 минут, чтобы экраны читали готовое, а не звали ИИ.
registerJobHandler(sellerFactsJob);
// Разбор первых секунд вышедшего ролика (24.09.2026) — ставит экран
// Маркетинг → Обзор (lib/firstSeconds.ts), один vision-вызов на ролик.
registerJobHandler(videoOpeningJob);
// Completion of a persisted local request is independent of enabling new writes.
registerJobHandler(customerCallbackNotifyJob);
registerJobHandler(customerIntakePolicyJob);
registerJobHandler(customerIntakeNotifyJob);
registerJobHandler(customerOwnerQuestionNotifyJob);
registerJobHandler(customerShowingNotifyJob);
registerJobHandler(customerInboxConsumeJob);
registerJobHandler(customerOutboxDispatchJob);
registerJobHandler(customerContactIntakeJob);
