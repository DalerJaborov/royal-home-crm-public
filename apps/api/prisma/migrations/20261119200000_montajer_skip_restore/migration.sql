-- Additive only (19.11.2026, second review): where to return a montajer-skipped object if receiving its final clip was cut off.
ALTER TABLE "Property" ADD COLUMN "videoHandoffManualRestoreStatus" TEXT;
