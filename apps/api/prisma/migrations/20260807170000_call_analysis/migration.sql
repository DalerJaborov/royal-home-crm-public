-- Разбор телефонного разговора: качество, возражения, договорённости.
--
-- Отдельная таблица, а не колонки в Interaction: разбор появляется позже звонка,
-- может пересчитываться на новой модели и нужен далеко не всем записям хронологии
-- (показы и встречи сюда не попадают).
--
-- agentId денормализован намеренно: сводки строятся по сотрудникам за период, и
-- каждый такой запрос иначе тянул бы за собой всю хронологию.
--
-- SQL написан вручную, а не сгенерирован `migrate diff`: генератор дополнительно
-- удаляет индексы pg_trgm, созданные отдельной миграцией и не описанные в схеме, —
-- их потеря сломала бы опечатко-устойчивый поиск.
CREATE TABLE "CallAnalysis" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "greeted" BOOLEAN NOT NULL DEFAULT false,
    "foundNeed" BOOLEAN NOT NULL DEFAULT false,
    "presentedValue" BOOLEAN NOT NULL DEFAULT false,
    "handledObjection" BOOLEAN NOT NULL DEFAULT false,
    "agreedNextStep" BOOLEAN NOT NULL DEFAULT false,
    "objections" TEXT[],
    "agreements" TEXT[],
    "summary" TEXT NOT NULL,
    "coaching" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallAnalysis_interactionId_key" ON "CallAnalysis"("interactionId");
CREATE INDEX "CallAnalysis_agentId_createdAt_idx" ON "CallAnalysis"("agentId", "createdAt");
CREATE INDEX "CallAnalysis_createdAt_idx" ON "CallAnalysis"("createdAt");

ALTER TABLE "CallAnalysis" ADD CONSTRAINT "CallAnalysis_interactionId_fkey"
    FOREIGN KEY ("interactionId") REFERENCES "Interaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAnalysis" ADD CONSTRAINT "CallAnalysis_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
