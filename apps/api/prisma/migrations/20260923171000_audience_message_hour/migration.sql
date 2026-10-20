-- Тепловая карта: счётчик входящих сообщений клиентов по часам и каналам.
CREATE TABLE "AudienceMessageHour" (
    "hourStart" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AudienceMessageHour_pkey" PRIMARY KEY ("hourStart","channel")
);
