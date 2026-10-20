-- Дежурная ротация для Settings.incomingRoutingMode = "dedicated_operator"
-- (лёгкая версия вместо полного возврата удалённой роли оператора, владелец
-- 20.08.2026) — см. комментарий у Settings.incomingDutyAgentIds в schema.prisma.
-- Пустой массив по умолчанию = поведение не меняется, пока список не заполнят.
ALTER TABLE "Settings" ADD COLUMN "incomingDutyAgentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
