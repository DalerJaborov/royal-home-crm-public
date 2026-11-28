-- Additive only (28.11.2026): Telegram file_id видеоуроков по CRM.
CREATE TABLE "LessonVideoCache" (
    "lang" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "fileSig" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonVideoCache_pkey" PRIMARY KEY ("lang","number")
);
