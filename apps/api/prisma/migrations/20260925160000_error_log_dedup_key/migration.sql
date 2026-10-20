-- Явный ключ дедупликации журнала ошибок (lib/systemError.ts, 25.09.2026).
ALTER TABLE "ErrorLog" ADD COLUMN "dedupKey" TEXT;
CREATE INDEX "ErrorLog_source_dedupKey_createdAt_idx" ON "ErrorLog"("source", "dedupKey", "createdAt");
