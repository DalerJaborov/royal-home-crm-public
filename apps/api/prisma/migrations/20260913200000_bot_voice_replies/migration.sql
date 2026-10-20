-- Голосовые ответы бота в переписке (13.09.2026) — выключено по умолчанию,
-- владелец: "создай, но выключи, сам протестирую сначала".
-- Написано руками (см. 20260912100200_bot_pause_watch) — БД недоступна в среде агента.

ALTER TABLE "Settings" ADD COLUMN "botCanSendVoiceReplies" BOOLEAN NOT NULL DEFAULT false;
