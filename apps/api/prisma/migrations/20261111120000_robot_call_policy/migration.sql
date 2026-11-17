-- Одна дверь «можно ли звонить роботом» (П3, 11.11.2026).
-- Аддитивно: новая таблица, новый enum, три поля Settings с умолчаниями, индекс на
-- LiveVoiceSession. Существующие строки не меняются, ничего не удаляется.

-- CreateEnum
CREATE TYPE "RobotCallStopSource" AS ENUM ('CONVERSATION', 'VOICE', 'STAFF', 'STATION');

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "companyHolidays" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "robotCallDailyMaxPerNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "robotCallWeeklyMaxPerNumber" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "RobotCallStop" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "clientId" TEXT,
    "source" "RobotCallStopSource" NOT NULL,
    "setByAgentId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedByAgentId" TEXT,

    CONSTRAINT "RobotCallStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RobotCallStop_phone_clearedAt_idx" ON "RobotCallStop"("phone", "clearedAt");

-- CreateIndex
CREATE INDEX "RobotCallStop_clientId_clearedAt_idx" ON "RobotCallStop"("clientId", "clearedAt");

-- Одна активная отметка на номер: повторная постановка не плодит записей (гонка двух
-- нажатий ловится уникальностью, а не проверкой «есть ли уже»).
CREATE UNIQUE INDEX "RobotCallStop_one_active_per_phone" ON "RobotCallStop"("phone") WHERE "clearedAt" IS NULL;

-- CreateIndex
CREATE INDEX "LiveVoiceSession_callerNumber_startedAt_idx" ON "LiveVoiceSession"("callerNumber", "startedAt");
