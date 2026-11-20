-- Бот клиентов отвечает по-человечески (владелец 20.11.2026). Только новые колонки, без переписи данных.
-- «Бот отвечает и после заявки» — ВКЛ (владелец прямо попросил это поведение); «Бот пишет своими словами» — ВЫКЛ до прогона
-- на живых диалогах (SPEC, этап 1.4); тишина после ответа сотрудника — 30 минут; номера проверяющих — пусто.
ALTER TABLE "Settings" ADD COLUMN "botRepliesAfterLeadEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "botStaffQuietMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "botOwnWords" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "botReviewerPhones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
