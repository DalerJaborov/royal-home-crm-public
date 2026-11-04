ALTER TABLE "AssistantTelegramGroup"
  ADD COLUMN "contextIncludeUnlinked" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "AssistantTelegramContext"
  ALTER COLUMN "authorAgentId" DROP NOT NULL,
  ADD COLUMN "authorTelegramId" TEXT;
