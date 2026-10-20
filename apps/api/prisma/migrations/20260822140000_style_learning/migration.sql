-- Самообучение стилю живых агентов (просьба владельца 22.08.2026: «чтобы бот
-- умнел с каждой перепиской», как в боте Ширин Свитс).
--
-- Бот учится НЕ переписыванием промта: копятся реальные пары «вопрос клиента →
-- ответ живого сотрудника», и лучшие из них подмешиваются в системный промт
-- отдельным блоком образцов (apps/api/src/ai/styleLearning.ts). Правила остаются
-- ровно там, где их написал человек.
--
-- Аддитивно: только новая таблица, ни одна существующая не трогается.
-- Внешнего ключа на "Agent" нарочно нет — сотрудника могут удалить, а его манера
-- остаётся ценной: пример не должен ни исчезать каскадом, ни мешать удалению.

-- CreateTable
CREATE TABLE "StyleExample" (
    "id" TEXT NOT NULL,
    "clientText" TEXT NOT NULL,
    "agentText" TEXT NOT NULL,
    "agentId" TEXT,
    "source" TEXT NOT NULL,
    "channel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StyleExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Защита от дублей на стороне базы: одну и ту же фразу сотрудники пишут десятки
-- раз, и повторная вставка обязана падать молча, а не заводить второй пример.
-- Длина обеих колонок ограничена в коде (300 символов ответа, 300 вопроса) —
-- иначе btree упёрся бы в предел размера строки индекса.
CREATE UNIQUE INDEX "StyleExample_clientText_agentText_key" ON "StyleExample"("clientText", "agentText");

-- CreateIndex
-- Так их и читают: включённые, самые свежие (buildStyleBlock).
CREATE INDEX "StyleExample_enabled_createdAt_idx" ON "StyleExample"("enabled", "createdAt");
