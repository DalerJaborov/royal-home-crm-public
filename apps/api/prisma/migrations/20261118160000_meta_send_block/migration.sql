-- 18.11.2026: Meta не пропускает отправку с аккаунта по правилам (код 368 и родня) —
-- метка аккаунта, лесенка проб и код/подкод ошибки отдельными полями (lib/metaSendBlock.ts).
-- Новая таблица, существующие данные не трогаются. Пустая таблица = прежнее поведение.
CREATE TABLE "MetaSendBlock" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "accountId" TEXT,
    "label" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 1,
    "probeStep" INTEGER NOT NULL DEFAULT 0,
    "nextProbeAt" TIMESTAMP(3) NOT NULL,
    "probeLeaseUntil" TIMESTAMP(3),
    "lastCode" INTEGER NOT NULL,
    "lastSubcode" INTEGER,
    "lastErrorType" TEXT,
    "lastFbtraceId" TEXT,
    "lastMessage" TEXT,
    "warningAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaSendBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MetaSendBlock_accountKey_surface_key" ON "MetaSendBlock"("accountKey", "surface");
CREATE INDEX "MetaSendBlock_liftedAt_idx" ON "MetaSendBlock"("liftedAt");
