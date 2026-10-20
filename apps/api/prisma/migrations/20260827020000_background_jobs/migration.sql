-- Персистентная очередь фоновых заданий (чертёж каркаса §2, 26.08.2026):
-- работа, которая раньше жила в setTimeout процесса и умирала каждым деплоем,
-- переезжает в Postgres. Аддитивно, поведение меняется по одному потребителю.
CREATE TYPE "BackgroundJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'GIVEN_UP');

CREATE TABLE IF NOT EXISTS "BackgroundJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BackgroundJob_dedupeKey_key" ON "BackgroundJob"("dedupeKey");

-- Главный запрос воркера: PENDING со сроком + подбор зависших RUNNING.
CREATE INDEX IF NOT EXISTS "BackgroundJob_status_runAt_idx" ON "BackgroundJob"("status", "runAt");
