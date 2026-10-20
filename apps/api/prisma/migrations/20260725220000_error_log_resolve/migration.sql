-- Возможность закрыть разобранную ошибку.
-- До этого «Здоровье системы» показывало счётчик, который нечем было обнулить:
-- директор видел «1 за сутки» и не мог отметить, что уже разобрался.
-- Разобранные ошибки остаются в журнале (до автоочистки через 90 дней),
-- но выпадают из счётчиков и из утреннего уведомления.

ALTER TABLE "ErrorLog" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "ErrorLog" ADD COLUMN "resolvedById" TEXT;

CREATE INDEX "ErrorLog_resolvedAt_idx" ON "ErrorLog"("resolvedAt");
