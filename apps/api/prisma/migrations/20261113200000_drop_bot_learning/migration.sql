-- «Обучение бота» удалено целиком (решение владельца 31.10 и 13.11.2026).
-- Данные выгружены с прода и разобраны 13.11.2026 ДО этой миграции
-- (BotLesson 463, BotAuditFinding 3645, LostConversation 237,
-- LostClientDigest 4, StyleExample 152 строк). Обратного пути у миграции нет:
-- восстановление — только из этой выгрузки или из резервной копии базы.
-- BotConversation, GuardHit и данные клиентов не затрагиваются.

-- DropForeignKey
ALTER TABLE "BotLesson" DROP CONSTRAINT IF EXISTS "BotLesson_digestId_fkey";
ALTER TABLE "LostConversation" DROP CONSTRAINT IF EXISTS "LostConversation_digestId_fkey";

-- DropTable
DROP TABLE IF EXISTS "BotLesson";
DROP TABLE IF EXISTS "LostConversation";
DROP TABLE IF EXISTS "LostClientDigest";
DROP TABLE IF EXISTS "BotAuditFinding";
DROP TABLE IF EXISTS "StyleExample";

-- AlterTable
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "botTrainingScreenEnabled";
