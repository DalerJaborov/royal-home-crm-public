-- Архив чатов (рубильник, по умолчанию включён) и миниатюра профиля собеседника.
ALTER TABLE "Settings" ADD COLUMN "chatArchiveEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ContactProfile" ADD COLUMN "avatarKey" TEXT;
ALTER TABLE "ContactProfile" ADD COLUMN "avatarFetchedAt" TIMESTAMP(3);
