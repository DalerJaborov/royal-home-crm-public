-- Пачка 8, 11.09.2026: сделка не должна виснуть по уже свободному объекту,
-- когда резерв истёк (docs/flow-audit-deal-11-09.md, БАГ №1).

ALTER TABLE "Settings" ADD COLUMN "dealReservationExpiryAction" TEXT NOT NULL DEFAULT 'cancel';

ALTER TABLE "Deal" ADD COLUMN "reservationExpiredAt" TIMESTAMP(3);
