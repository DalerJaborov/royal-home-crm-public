-- Человек в рабочей группе: приветствие один раз и подсказка непривязанному не чаще раза в 6 часов (26.11.2026).
-- Только новая таблица, существующие данные не трогает.
CREATE TABLE "AssistantGroupPerson" (
    "chatId" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "welcomedAt" TIMESTAMP(3),
    "linkHintAt" TIMESTAMP(3),
    "linkHintCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AssistantGroupPerson_pkey" PRIMARY KEY ("chatId","telegramUserId")
);

CREATE INDEX "AssistantGroupPerson_linkHintAt_idx" ON "AssistantGroupPerson"("linkHintAt");
CREATE INDEX "AssistantGroupPerson_welcomedAt_idx" ON "AssistantGroupPerson"("welcomedAt");
