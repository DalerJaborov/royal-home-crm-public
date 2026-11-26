-- Ручной архив чатов: метка действует, пока в диалоге нет нового входящего.
ALTER TABLE "BotConversation" ADD COLUMN "archiveMark" TEXT;
ALTER TABLE "BotConversation" ADD COLUMN "archiveMarkAt" TIMESTAMP(3);
ALTER TABLE "TelegramConversation" ADD COLUMN "archiveMark" TEXT;
ALTER TABLE "TelegramConversation" ADD COLUMN "archiveMarkAt" TIMESTAMP(3);
ALTER TABLE "TelegramDirectConversation" ADD COLUMN "archiveMark" TEXT;
ALTER TABLE "TelegramDirectConversation" ADD COLUMN "archiveMarkAt" TIMESTAMP(3);
