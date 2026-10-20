-- Пачка 9 (11.09.2026): «RESERVED без движения» — настраиваемый порог дней,
-- после которого агент и руководитель получают пуш о простое сделки. Резерв
-- при этом не снимается (см. docs/flow-audit-property-11-09.md, п.4).
ALTER TABLE "Settings" ADD COLUMN "dealStaleReserveDays" INTEGER NOT NULL DEFAULT 7;
