-- Бот присылает агенту готовый пост его объекта со ссылками «поделиться» (28.09.2026).
ALTER TABLE "Settings" ADD COLUMN "agentSharePostTelegram" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Agent" ADD COLUMN "sharePostTelegram" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Property" ADD COLUMN "agentSharePostSentAt" TIMESTAMP(3);
