-- Предложения ИИ по заполнению карточки после телефонного разговора.
--
-- Решение владельца 07.08.2026: поля карточки из живой речи заполняются НЕ молча,
-- а с подтверждением агента — тот, кто говорил с клиентом, единственный может
-- сказать, верно ли машина расслышала. Для переписки с ботом молчаливое заполнение
-- остаётся (lib/clientAutopilot.ts): там текст точный.
--
-- interactionId уникален: одно предложение на один разговор, иначе повторный разбор
-- завалил бы агента одинаковыми карточками.
--
-- SQL написан вручную, а не сгенерирован `migrate diff`: генератор дополнительно
-- удаляет индексы pg_trgm (Client_fullName_trgm_idx и соседние), созданные отдельной
-- миграцией и не описанные в schema.prisma; их потеря сломала бы опечатко-устойчивый
-- поиск по клиентам и объектам.
CREATE TABLE "CardSuggestion" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "interactionId" TEXT,
    "agentId" TEXT NOT NULL,
    "budgetMin" DECIMAL(65,30),
    "budgetMax" DECIMAL(65,30),
    "districtId" TEXT,
    "rooms" INTEGER,
    "type" "PropertyType",
    "notes" TEXT,
    "evidence" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CardSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CardSuggestion_interactionId_key" ON "CardSuggestion"("interactionId");
CREATE INDEX "CardSuggestion_clientId_status_idx" ON "CardSuggestion"("clientId", "status");
CREATE INDEX "CardSuggestion_agentId_status_idx" ON "CardSuggestion"("agentId", "status");

ALTER TABLE "CardSuggestion" ADD CONSTRAINT "CardSuggestion_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardSuggestion" ADD CONSTRAINT "CardSuggestion_interactionId_fkey"
    FOREIGN KEY ("interactionId") REFERENCES "Interaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CardSuggestion" ADD CONSTRAINT "CardSuggestion_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardSuggestion" ADD CONSTRAINT "CardSuggestion_districtId_fkey"
    FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;
