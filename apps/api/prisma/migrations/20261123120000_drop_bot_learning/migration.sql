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
-- Что увидит старый код в эти секунды, если таблиц уже нет: подмешивание правил
-- и образцов манеры в промт и запись урока/образца после ответа оператора
-- обёрнуты в try/catch — бот отвечает без них; экраны и пути «Обучения бота»
-- (/bot-learning, /bot-audit, /bot-training) отдадут ошибку; задачи bot-lessons
-- (каждые 2 часа в :30), lost-conversations (02:45) и bot-audit (03:15) по
-- Душанбе упадут с записью в журнал ошибок, если выкат придётся на их минуту.
-- Ответы клиентам это не роняет.

-- DropForeignKey
ALTER TABLE "BotLesson" DROP CONSTRAINT IF EXISTS "BotLesson_digestId_fkey";
ALTER TABLE "LostConversation" DROP CONSTRAINT IF EXISTS "LostConversation_digestId_fkey";

-- DropTable
DROP TABLE IF EXISTS "BotLesson";
DROP TABLE IF EXISTS "LostConversation";
DROP TABLE IF EXISTS "LostClientDigest";
DROP TABLE IF EXISTS "BotAuditFinding";
DROP TABLE IF EXISTS "StyleExample";

-- Следы удалённых задач: иначе «Состояние функций» и сторож тиков показывают их
-- навсегда застывшими. Модули пульта — на случай, если их когда-то выключали.
DELETE FROM "CronHeartbeat" WHERE "name" IN ('bot-lessons', 'bot-audit', 'lost-conversations', 'weekly-lost-digest');
DELETE FROM "PultModule" WHERE "id" IN ('aiBotAudit', 'aiLostConversations');
