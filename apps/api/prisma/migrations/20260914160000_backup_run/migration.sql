-- BackupRun — журнал отчётов ops/backup.sh и ops/restore-drill.sh (перенос
-- мобильного макета 14.09.2026, шаг 5 «/backups»). См. комментарий у модели
-- в schema.prisma. Написана вручную по образцу CreateTable, база для сверки
-- через `prisma migrate dev` в этой сессии недоступна (см. `docs/TASKS.md`).

CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "sizeLabel" TEXT,
    "detail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackupRun_kind_finishedAt_idx" ON "BackupRun"("kind", "finishedAt");
