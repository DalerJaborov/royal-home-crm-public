-- Сообщение автоответчика приходит директору в Шабнам (21.11.2026). Только добавляет рубильник (ВКЛ).
ALTER TABLE "Settings" ADD COLUMN "voicemailToShabnamEnabled" BOOLEAN NOT NULL DEFAULT true;
