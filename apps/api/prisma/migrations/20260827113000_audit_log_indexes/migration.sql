-- Индексы журнала действий (27.08.2026, аудит №4): квота передач клиента и
-- недельный отчёт проблем фильтруют по action/agentId, а покрытия не было —
-- каждый «Передать клиента» сканировал весь вечно растущий журнал.
-- CONCURRENTLY нельзя: Prisma гоняет миграции в транзакции. Таблица растёт, но
-- блокировка на построение индекса здесь — секунды, и это разовая цена.
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_agentId_createdAt_idx" ON "AuditLog"("agentId", "createdAt");
