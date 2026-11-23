-- «Обучение бота» удалено целиком (решение владельца 31.10, 13.11 и 23.11.2026).
-- Код этих таблиц больше не читает и не пишет. Строк на проде 23.11.2026:
-- BotLesson 515, BotAuditFinding 4340, LostConversation 263,
-- LostClientDigest 5, StyleExample 186 (выгрузка 13.11 их уже не покрывает —
-- таблицы пополнялись до самого выката). Обратного пути у миграции нет:
-- восстановление — только из дампа этих таблиц, снятого прямо перед выкатом,
-- или из ночной копии базы. BotConversation, GuardHit и данные клиентов не
-- затрагиваются.
--
-- Settings.botTrainingScreenEnabled здесь НАРОЧНО не снимается: ops/deploy.sh
-- применяет миграции, пока старые api/worker ещё работают, а их Prisma читает
-- Settings всеми колонками. Колонку снимет отдельная миграция следующего выката.
-- Старый код читает эти таблицы только внутри try/catch (промт бота) или в
-- ночных задачах — секунды перекрытия на выкате им не страшны.

-- DropForeignKey
ALTER TABLE "BotLesson" DROP CONSTRAINT IF EXISTS "BotLesson_digestId_fkey";
ALTER TABLE "LostConversation" DROP CONSTRAINT IF EXISTS "LostConversation_digestId_fkey";

-- DropTable
DROP TABLE IF EXISTS "BotLesson";
DROP TABLE IF EXISTS "LostConversation";
DROP TABLE IF EXISTS "LostClientDigest";
DROP TABLE IF EXISTS "BotAuditFinding";
DROP TABLE IF EXISTS "StyleExample";
