-- Ревью #497 (27.11.2026).
-- 1. Отметка прохода «номер из переписки — в карточку» (lib/phoneLeadWatchdog.ts, sweepCardConversationPhones):
--    переписка разбирается заново, только если в ней появилось новое сообщение. Колонка не входит в триггер
--    customer_native_revisions — её запись ревизий ядра не трогает.
ALTER TABLE "BotConversation" ADD COLUMN "phoneSweepAt" TIMESTAMP(3);
-- 2. Свой рубильник «номер одним сообщением — в карточку», отдельно от карточки по несостоявшемуся ходу WhatsApp.
--    ВКЛ по умолчанию: работает сразу после выката, выключает человек.
ALTER TABLE "Settings" ADD COLUMN "chatBarePhoneToCardEnabled" BOOLEAN NOT NULL DEFAULT true;
