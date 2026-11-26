-- Срок жизни кода привязки Telegram и подпись «это тот же человек» (25.11.2026).
-- Обе колонки необязательные, без значения по умолчанию; срок ставится только недоиспользованным кодам (ниже).
ALTER TABLE "Agent" ADD COLUMN "telegramLinkCodeExpiresAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "samePersonAgentId" TEXT;

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_samePersonAgentId_fkey" FOREIGN KEY ("samePersonAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Коды, выданные до этой правки, были бессрочными (ревью 25.11.2026): даём им сутки с момента
-- выката, дальше они гаснут, как новые. Уже привязанные чаты не трогаются: у них кода нет.
-- Время в UTC явно: колонка без пояса, Prisma читает её как UTC, а пояс сессии базы может быть другим.
UPDATE "Agent" SET "telegramLinkCodeExpiresAt" = (NOW() AT TIME ZONE 'UTC') + interval '1 day'
WHERE "telegramLinkCode" IS NOT NULL AND "telegramLinkCodeExpiresAt" IS NULL;
