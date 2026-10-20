-- Пульс крон-тиков (26.08.2026, архитектурное ревью, пункт 9): тик, который
-- молча перестал запускаться, становится виден за часы, а не через неделю.
CREATE TABLE IF NOT EXISTS "CronHeartbeat" (
    "name" TEXT NOT NULL,
    "expr" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "alertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronHeartbeat_pkey" PRIMARY KEY ("name")
);
