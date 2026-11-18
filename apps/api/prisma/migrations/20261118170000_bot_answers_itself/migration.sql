-- «Бот отвечает сам» (владелец 18.11.2026) и придержка раздачи карточки по номеру из комментария.
-- Только добавление колонок: настройка выключена по умолчанию, у старых карточек придержки нет —
-- поведение не меняется, пока владелец не включит тумблер. Читает lib/botAnswersItself.ts и
-- lib/commentPhoneHold.ts.
ALTER TABLE "Settings" ADD COLUMN "botAnswersItself" BOOLEAN NOT NULL DEFAULT false;
-- Номер из комментария: разговор (личное, публичный ответ, скрытие). Включён по умолчанию — решение владельца.
ALTER TABLE "Settings" ADD COLUMN "botCommentPhoneConversation" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Client" ADD COLUMN "commentPhoneHoldUntil" TIMESTAMP(3);
