-- Ключи Meta переезжают в Настройки, как ключи Claude и Gemini.
-- Причина простая: владелец не должен редактировать файл на сервере по SSH,
-- чтобы подключить канал. Секреты хранятся зашифрованными (AES-256-GCM),
-- переменные окружения остаются запасным вариантом.

ALTER TABLE "Settings" ADD COLUMN "metaAppSecret" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaVerifyToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaWaToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaWaPhoneId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "metaIgToken" TEXT;
