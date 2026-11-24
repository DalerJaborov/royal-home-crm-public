-- Звать агента сразу при падении хода бота клиента (24.11.2026), ВКЛ. Только новая колонка.
ALTER TABLE "Settings" ADD COLUMN "botCoreFailAlertEnabled" BOOLEAN NOT NULL DEFAULT true;
