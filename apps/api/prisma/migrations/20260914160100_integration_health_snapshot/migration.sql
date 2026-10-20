-- IntegrationHealthSnapshot — снимок ночной самопроверки внешних доступов
-- (перенос мобильного макета 14.09.2026, шаг 5 «/integrations»). См.
-- комментарий у модели в schema.prisma. Написана вручную, см.
-- 20260914160000_backup_run/migration.sql про недоступность базы для сверки.

CREATE TABLE "IntegrationHealthSnapshot" (
    "name" TEXT NOT NULL,
    "ok" BOOLEAN,
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationHealthSnapshot_pkey" PRIMARY KEY ("name")
);
