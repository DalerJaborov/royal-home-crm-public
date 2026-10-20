-- Обработанные сообщения автоответчика: идемпотентность забора со станции.
CREATE TABLE "VoicemailMessage" (
    "id" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT,
    "interactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoicemailMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VoicemailMessage_file_key" ON "VoicemailMessage"("file");
