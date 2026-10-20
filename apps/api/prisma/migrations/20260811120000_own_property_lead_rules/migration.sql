-- Приоритет «свой объект», лимиты лидов, действия в шторке уведомлений и
-- удержание темы ботом — решения владельца 11.08.2026. Все значения правятся
-- в Настройках, ни одно не живёт в коде.
--
-- ВНИМАНИЕ: `prisma migrate diff` для этой миграции дополнительно предложил
-- DROP INDEX для Client_fullName_trgm_idx, Property_address_trgm_idx и
-- Property_title_trgm_idx. Это НЕ изменение схемы: триграммные индексы заведены
-- отдельной сырой миграцией и в datamodel Prisma их нет по определению, поэтому
-- diff видит их как «лишние». Удалять их нельзя — на них держится поиск.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "ownPropertyPriorityEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ownPropertyMatchThreshold" INTEGER NOT NULL DEFAULT 85,
ADD COLUMN     "ownPropertyShownExceptionEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ownPropertyShownWindowDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "ownPropertyOverLimitEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ownPropertyReleaseEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ownPropertyReleaseMode" TEXT NOT NULL DEFAULT 'agent_choice',
ADD COLUMN     "ownPropertyLeadCap" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "handoverClientsToHighKpi" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "handoverPropertiesToLowKpi" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushLeadActionsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushActionTtlMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "botTopicLockEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botTopicDriftTurns" INTEGER NOT NULL DEFAULT 1;
