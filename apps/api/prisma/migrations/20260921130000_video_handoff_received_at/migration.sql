-- Момент реального приёма готового ролика от монтажёра (случай №114, 21.09.2026):
-- рестарт контейнеров посреди публикации обрывал её молча, объект зависал в
-- RECEIVED/EDITING без единой ошибки в журнале. Watchdog
-- (lib/videoHandoffUnfinishedPublishWatchdog.ts) отличает "публикация идёт прямо
-- сейчас" от "зависло" по этому полю, а не по videoHandoffSentAt (то про отправку
-- монтажёру, не про приём готового файла).
ALTER TABLE "Property" ADD COLUMN "videoHandoffReceivedAt" TIMESTAMP(3);
