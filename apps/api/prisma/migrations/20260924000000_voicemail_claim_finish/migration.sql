-- Замок на сообщении автоответчика отмечает начало работы, но не её конец:
-- падение процесса посреди расшифровки теряло сообщение навсегда. Добавляем
-- отметку о доведённой до конца работе, время последнего захода и счётчик
-- попыток (потолок повторов — платная расшифровка).
ALTER TABLE "VoicemailMessage" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "VoicemailMessage" ADD COLUMN "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "VoicemailMessage" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;

-- Всё, что лежит в базе сейчас, разобрано прежним кодом до конца (иначе его бы
-- не было): отмечаем временем создания, чтобы проход не взялся за них заново.
UPDATE "VoicemailMessage" SET "processedAt" = "createdAt" WHERE "processedAt" IS NULL;

CREATE INDEX "VoicemailMessage_processedAt_idx" ON "VoicemailMessage"("processedAt");
