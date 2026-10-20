-- Пачка 17 (12.09.2026): «бот на паузе и забыли» — lib/botPauseWatch.ts.
-- Написано руками (agent-briefs/ownership-security-11-09.md — prisma generate
-- в worktree запрещён), сверено со schema.prisma.

ALTER TABLE "BotConversation" ADD COLUMN "pauseAlertSentAt" TIMESTAMP(3);
ALTER TABLE "TelegramConversation" ADD COLUMN "pauseAlertSentAt" TIMESTAMP(3);

ALTER TABLE "Settings" ADD COLUMN "botPauseWatchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "botPauseAlertHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "Settings" ADD COLUMN "botPauseEscalateHours" INTEGER NOT NULL DEFAULT 72;
