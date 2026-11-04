ALTER TABLE "AssistantTelegramGroup"
  ADD COLUMN "proactiveMutedUntil" TIMESTAMP(3),
  ADD COLUMN "lastProactiveReplyAt" TIMESTAMP(3),
  ADD COLUMN "lastJoinWelcomeAt" TIMESTAMP(3);
