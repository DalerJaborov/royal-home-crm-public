-- Пачка 18 (12.09.2026): пропущенные звонки без перезвона — часы порогов.
-- Написано руками (prisma generate в worktree запрещён), сверено со schema.prisma.

ALTER TABLE "Settings" ADD COLUMN "missedCallbackHours" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Settings" ADD COLUMN "missedCallbackEscalateHours" INTEGER NOT NULL DEFAULT 6;
