-- Одна дверь звонков робота, доработка после ревью (П3, 11.11.2026). Аддитивно.

-- Отложенный дверью звонок рекрутинга не загораживает очередь.
ALTER TABLE "RecruitmentCommunication" ADD COLUMN "retryAfter" TIMESTAMP(3);

-- Разрешение руководства звонить роботом вопреки «не беспокойте» в переписке.
CREATE TABLE "RobotCallAllow" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "allowedByAgentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByAgentId" TEXT,

    CONSTRAINT "RobotCallAllow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RobotCallAllow_clientId_revokedAt_idx" ON "RobotCallAllow"("clientId", "revokedAt");

-- Одно действующее разрешение на карточку.
CREATE UNIQUE INDEX "RobotCallAllow_one_active_per_client" ON "RobotCallAllow"("clientId") WHERE "revokedAt" IS NULL;
