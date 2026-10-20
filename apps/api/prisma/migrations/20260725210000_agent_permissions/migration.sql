-- Персональные надстройки прав поверх пресета роли.
-- Формат: {"granted": ["keys.view", ...], "revoked": ["finance.view", ...]}
-- NULL — сотрудник работает ровно по пресету своей роли (так у всех после миграции,
-- поэтому текущее поведение системы не меняется ни для кого).
-- Реестр прав и правила слияния — packages/shared/src/permissions.ts.

ALTER TABLE "Agent" ADD COLUMN "permissions" JSONB;
