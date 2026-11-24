-- Потолок фонового повтора ответа бота клиента (25.11.2026), ВКЛ. Только новая колонка.
ALTER TABLE "Settings" ADD COLUMN "botRetryCapEnabled" BOOLEAN NOT NULL DEFAULT true;
