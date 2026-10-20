-- Исход разбора «Не по делу»: курьер, реклама, ошиблись номером.
--
-- Идемпотентно (IF NOT EXISTS) — `migrate deploy` на этом проекте уже падал с
-- deadlock 40P01 из-за параллельной сессии, и лечение состоит в повторе миграции.
--
-- Написано руками, а не `migrate diff`: тот к этим правкам дописывает удаление
-- триграммных индексов (они заведены сырым SQL и в schema.prisma не выражаются),
-- что молча вернуло бы поиск с опечатками к чтению таблицы целиком.

ALTER TABLE "IncomingCall" ADD COLUMN IF NOT EXISTS "irrelevant" BOOLEAN NOT NULL DEFAULT false;

-- Вопрос «звонил ли этот номер и не помечен ли он как не по делу» задаётся при
-- каждом звонке с незнакомого номера — то есть в горячем пути обработки события АТС.
CREATE INDEX IF NOT EXISTS "IncomingCall_phone_irrelevant_idx" ON "IncomingCall" ("phone", "irrelevant");
