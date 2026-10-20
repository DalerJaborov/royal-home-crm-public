-- Аннулирование закрытой сделки (глубокая проверка 02.10.2026, C10).
-- Только добавление колонок: старые поля не трогаются.
ALTER TABLE "Deal" ADD COLUMN "annulledAt" TIMESTAMP(3);
ALTER TABLE "Deal" ADD COLUMN "annulledById" TEXT;
ALTER TABLE "Deal" ADD COLUMN "annulReason" TEXT;

ALTER TABLE "Deal" ADD CONSTRAINT "Deal_annulledById_fkey" FOREIGN KEY ("annulledById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
