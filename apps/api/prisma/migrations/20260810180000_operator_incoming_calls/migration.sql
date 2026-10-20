-- Рабочее место оператора входящих звонков (решение владельца 10.08.2026).
--
-- ВНИМАНИЕ, ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. `prisma migrate diff` к этим правкам сам
-- дописал три строки `DROP INDEX "Client_fullName_trgm_idx"` и такие же по
-- Property: триграммные индексы заведены сырым SQL и в schema.prisma не
-- выражаются, поэтому для diff их «не существует». Выполнение такой миграции
-- молча вернуло бы поиск с опечатками к последовательному чтению таблицы —
-- ровно то, что чинилось 10.08.2026 (33db0f0). Строки удалены руками.
--
-- Всё ниже идемпотентно (IF NOT EXISTS): `migrate deploy` на этом проекте уже
-- падал с deadlock 40P01 из-за параллельной сессии, и лечение — повтор той же
-- миграции. Повтор обязан быть безопасным.

-- Журнал входящих: кто разобрал звонок и завёл ли он карточку сам.
ALTER TABLE "IncomingCall" ADD COLUMN IF NOT EXISTS "autoCreatedClient" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IncomingCall" ADD COLUMN IF NOT EXISTS "qualifiedAt" TIMESTAMP(3);
ALTER TABLE "IncomingCall" ADD COLUMN IF NOT EXISTS "qualifiedById" TEXT;

-- Настройки раздела «Входящие звонки» — все шесть правятся без выката кода.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingOperatorIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingAutoCreateClient" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingDefaultKind" TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingAssignOnQualify" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingForwardPhone" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingPanelEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Внешний ключ отдельным блоком: `ADD CONSTRAINT` не знает IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IncomingCall_qualifiedById_fkey') THEN
    ALTER TABLE "IncomingCall"
      ADD CONSTRAINT "IncomingCall_qualifiedById_fkey"
      FOREIGN KEY ("qualifiedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Под вопрос «какие звонки остались неразобранными» — он задаётся каждый день,
-- а без индекса это чтение всего журнала входящих.
CREATE INDEX IF NOT EXISTS "IncomingCall_qualifiedAt_startedAt_idx" ON "IncomingCall" ("qualifiedAt", "startedAt");
