-- Заготовка на будущий переключатель "как маршрутизировать незнакомый звонок"
-- (веерный вызов / очередь по KPI / оператор / IVR-меню) — см. комментарий у
-- Settings.incomingRoutingMode в schema.prisma. Значение по умолчанию совпадает
-- с единственным реально работающим сейчас поведением, поэтому применение
-- миграции ничего в живой телефонии не меняет.
ALTER TABLE "Settings" ADD COLUMN "incomingRoutingMode" TEXT NOT NULL DEFAULT 'assigned_then_forward';
