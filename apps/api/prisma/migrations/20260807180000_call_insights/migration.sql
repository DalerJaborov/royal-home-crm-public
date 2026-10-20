-- Ночной разбор всех разговоров: сильные и слабые стороны агентства.
--
-- Отдельная таблица, потому что хранить его негде: остальные ИИ-подсказки в CRM
-- считаются на лету при открытии дашборда, а этот разбор стоит вызова модели и
-- собирается раз в сутки.
--
-- SQL написан вручную, а не сгенерирован `migrate diff`: генератор дополнительно
-- удаляет индексы pg_trgm, созданные отдельной миграцией и не описанные в схеме.
CREATE TABLE "CallInsight" (
    "id" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "calls" INTEGER NOT NULL,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "demand" TEXT[],
    "actions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallInsight_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallInsight_createdAt_idx" ON "CallInsight"("createdAt");
