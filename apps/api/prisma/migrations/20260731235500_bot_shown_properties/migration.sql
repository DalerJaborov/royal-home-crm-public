-- Предохранитель от повторного показа объекта фотографиями одному и тому же собеседнику.
CREATE TABLE "ShownProperty" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "shortId" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShownProperty_pkey" PRIMARY KEY ("id")
);

-- Один объект — одна отметка на собеседника: повторный показ обновляет её (upsert),
-- а не заводит вторую.
CREATE UNIQUE INDEX "ShownProperty_channel_recipientId_shortId_key" ON "ShownProperty"("channel", "recipientId", "shortId");

-- По времени отметки идёт уборка просроченных.
CREATE INDEX "ShownProperty_sentAt_idx" ON "ShownProperty"("sentAt");
