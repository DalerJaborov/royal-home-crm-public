-- Рубильник OpenAI целиком: по умолчанию выключен (решение владельца 14.11.2026).
ALTER TABLE "Settings" ADD COLUMN "openaiEnabled" BOOLEAN NOT NULL DEFAULT false;
