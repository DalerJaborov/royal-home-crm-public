-- Журнал сообщений помощницы сотруднику по её почину (telegram/staffNotice.ts).
CREATE TABLE "StaffNotice" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupKey" TEXT,
    "chatId" TEXT,
    "messageId" INTEGER,
    "subject" TEXT,
    "remindOn" TEXT,
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffNotice_dedupKey_key" ON "StaffNotice"("dedupKey");
CREATE INDEX "StaffNotice_agentId_createdAt_idx" ON "StaffNotice"("agentId", "createdAt");
CREATE INDEX "StaffNotice_chatId_messageId_idx" ON "StaffNotice"("chatId", "messageId");
CREATE INDEX "StaffNotice_remindOn_firedAt_idx" ON "StaffNotice"("remindOn", "firedAt");
