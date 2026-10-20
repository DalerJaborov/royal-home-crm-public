-- Дедуп/автозакрытие автозадач (21.09.2026, docs/TASKS.md «Автозадачи не видят
-- состоявшегося контакта»). Machine-tag какой генератор завёл nextAction —
-- см. комментарий у Interaction.autoTaskKind в schema.prisma и lib/autoTasks.ts.

ALTER TABLE "Interaction" ADD COLUMN "autoTaskKind" TEXT;

CREATE INDEX "Interaction_clientId_autoTaskKind_completedAt_idx" ON "Interaction"("clientId", "autoTaskKind", "completedAt");
