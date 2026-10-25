ALTER TABLE "BotLesson" ADD COLUMN "investigationOnly" BOOLEAN NOT NULL DEFAULT false;

-- Preserve original examples, lesson text and activation state for private review.
UPDATE "BotLesson" SET "investigationOnly" = true WHERE "kind" IN ('audit_finding', 'audit');
