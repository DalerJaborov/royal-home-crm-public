-- Кто рисует обложки: TEMPLATE (наш шаблон Royal Green) | OPENAI.
ALTER TABLE "Settings" ADD COLUMN "coverProvider" TEXT NOT NULL DEFAULT 'TEMPLATE';
