-- «Бот отвечает сам» (владелец 18.11.2026) и придержка раздачи карточки по номеру из комментария.
-- Только добавление колонок: настройка выключена по умолчанию, у старых карточек придержки нет —
-- поведение не меняется, пока владелец не включит тумблер. Читает lib/botAnswersItself.ts и
-- lib/commentPhoneHold.ts.
-- Имя 20.11.2026: прежняя метка 20261118170000 была старше уже выкаченных миграций main (по образцу
-- 2026-11-17-lead-only-quiet.md). Только добавление колонок и один индекс.
ALTER TABLE "Settings" ADD COLUMN "botAnswersItself" BOOLEAN NOT NULL DEFAULT false;
-- Номер из комментария: разговор (личное, публичный ответ, скрытие). Выключен по умолчанию: включается после «да» владельца на тексты.
ALTER TABLE "Settings" ADD COLUMN "botCommentPhoneConversation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Client" ADD COLUMN "commentPhoneHoldUntil" TIMESTAMP(3);
-- Номер из комментария становится заявкой только при ВКЛ (рубильник ревью #283, 20.11.2026). Выключен по умолчанию.
ALTER TABLE "Settings" ADD COLUMN "botCommentPhoneLead" BOOLEAN NOT NULL DEFAULT false;
-- Тик раздачи снимает придержку по commentPhoneHoldUntil not null: без индекса — проход по всей таблице клиентов.
CREATE INDEX "Client_commentPhoneHoldUntil_idx" ON "Client"("commentPhoneHoldUntil");
