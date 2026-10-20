-- Пачка 12 (11.09.2026): реактивация старых клиентов пачкой.
-- Написано руками (agent-briefs/ownership-security-11-09.md — prisma generate
-- в worktree запрещён), сверено со schema.prisma.

ALTER TABLE "Settings" ADD COLUMN "reactivationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "reactivationAfterDays" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Settings" ADD COLUMN "reactivationBatchSize" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "Settings" ADD COLUMN "reactivationMessageTemplate" TEXT NOT NULL DEFAULT 'Здравствуйте, {name}! Это Royal Home. Ваш вопрос с недвижимостью всё ещё актуален? Если да — {agent} на связи и поможет.';
