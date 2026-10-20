-- Additive payload-less marker. Historical admissions stay NULL; no backfill or
-- inference of message persistence, endpoint ownership or action authorization.
ALTER TABLE "CustomerPropertyIngressTicket" ADD COLUMN "inputRecordedAt" TIMESTAMP(3);
