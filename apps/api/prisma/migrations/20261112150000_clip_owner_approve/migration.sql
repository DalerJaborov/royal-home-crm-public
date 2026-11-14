-- Готовый ролик подтверждает хозяин объекта, без ответа — автопубликация (11.11.2026).
ALTER TABLE "Settings" ADD COLUMN "clipOwnerApproveEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "clipOwnerAutoPublishHours" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Property" ADD COLUMN "clipOwnerDueAt" TIMESTAMP(3);
