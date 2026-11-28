-- Additive only (28.11.2026): auto redial of missed calls. Switches OFF by default.
ALTER TABLE "Settings" ADD COLUMN "missedCallRedialEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "missedCallRedialDelays" TEXT NOT NULL DEFAULT '5,30,120';
ALTER TABLE "Settings" ADD COLUMN "missedCallRedialJunkEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MissedCallRedial" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "incomingCallId" TEXT,
    "clientId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'phone',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "operatorNoPickups" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastInteractionId" TEXT,
    "lastOutcome" TEXT,
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MissedCallRedial_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MissedCallRedial_status_nextAttemptAt_idx" ON "MissedCallRedial"("status", "nextAttemptAt");
CREATE INDEX "MissedCallRedial_phone_idx" ON "MissedCallRedial"("phone");
-- One live queue row per phone: a repeated missed call must not create a second queue.
CREATE UNIQUE INDEX "MissedCallRedial_phone_pending_key" ON "MissedCallRedial"("phone") WHERE "status" = 'pending';
