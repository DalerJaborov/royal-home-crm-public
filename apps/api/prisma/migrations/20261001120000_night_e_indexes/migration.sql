-- Ночная проверка 24.09 → добивка 01.10.2026, пачка E (№196–199): индексы под фоновые выборки.
-- Только CREATE INDEX IF NOT EXISTS: ни столбцов, ни данных не трогаем.

-- №196: shouldAlert (lib/notifications.ts) — «последнее с этим tag», 12 тревог раз в час.
CREATE INDEX IF NOT EXISTS "Notification_tag_createdAt_idx" ON "Notification"("tag", "createdAt");
-- №196/№199: ночная уборка ленты (cron.ts, log-cleanup) — createdAt < срок без агента.
CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX IF NOT EXISTS "PendingDirectorAlert_tag_createdAt_idx" ON "PendingDirectorAlert"("tag", "createdAt");

-- №197: штраф за первый звонок (services/leads/firstCall.ts) ищет событие по одному sourceId.
CREATE INDEX IF NOT EXISTS "RoyalScoreEvent_sourceId_idx" ON "RoyalScoreEvent"("sourceId");

-- №198: старт API/worker (lib/telephony/callRecordings.ts, recoverInterruptedTranscriptionStages)
-- смотрит только строки с непустой стадией — их единицы на миллионы звонков. Частичный индекс
-- в schema.prisma не описать (Prisma их не знает), поэтому только здесь.
CREATE INDEX IF NOT EXISTS "Interaction_transcriptionStage_partial_idx"
  ON "Interaction"("transcriptionStage") WHERE "transcriptionStage" IS NOT NULL;

-- №199: lib/stuckPulse.ts — незакрытые обязательные окна старше суток, без агента в условии.
CREATE INDEX IF NOT EXISTS "PendingSummary_doneAt_dismissedAt_dueAt_idx" ON "PendingSummary"("doneAt", "dismissedAt", "dueAt");

-- №199: тревоги по клиентам берут «у кого флаг/число заполнено» — таких карточек малая доля,
-- поэтому частичные индексы (тоже не описываются в schema.prisma).
CREATE INDEX IF NOT EXISTS "Client_phoneAskFlaggedAt_partial_idx"
  ON "Client"("phoneAskFlaggedAt") WHERE "phoneAskFlaggedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Client_refusedHighScoreFlaggedAt_partial_idx"
  ON "Client"("refusedHighScoreFlaggedAt") WHERE "refusedHighScoreFlaggedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Client_sellerDeclaredPropertyCountAt_partial_idx"
  ON "Client"("sellerDeclaredPropertyCountAt") WHERE "sellerDeclaredPropertyCount" > 0 AND "sellerDeclaredPropertyCountAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Client_buyerDesiredPropertyCountAt_partial_idx"
  ON "Client"("buyerDesiredPropertyCountAt") WHERE "buyerDesiredPropertyCount" > 0 AND "buyerDesiredPropertyCountAt" IS NOT NULL;
