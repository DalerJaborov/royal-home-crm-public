-- Авторство хронологии (17.09.2026, П-10, docs/audit/lead-ownership-17-09.md §2,
-- docs/audit/recon-17-09/04-timeline-authorship.md). Написано руками (prisma
-- migrate dev запрещён в worktree), сверено со schema.prisma.
--
-- Миграция №1 из двух: только добавление, ничего не блокирует и не переносит
-- данные. agentId становится nullable, но существующие строки НЕ трогаются —
-- у них agentId уже заполнен, actorKind получает DEFAULT 'AGENT', так что
-- поведение читающего кода не меняется до бэкофилла (миграция №2, отдельным
-- заданием, после которого добавляется CHECK).
CREATE TYPE "InteractionActorKind" AS ENUM ('AGENT', 'SYSTEM', 'AI', 'BOT', 'CLIENT');

ALTER TABLE "Interaction" ADD COLUMN "actorKind" "InteractionActorKind" NOT NULL DEFAULT 'AGENT';

ALTER TABLE "Interaction" ALTER COLUMN "agentId" DROP NOT NULL;

ALTER TABLE "Interaction" ADD COLUMN "subjectAgentId" TEXT;

CREATE INDEX "Interaction_subjectAgentId_idx" ON "Interaction"("subjectAgentId");

ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_subjectAgentId_fkey"
  FOREIGN KEY ("subjectAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
