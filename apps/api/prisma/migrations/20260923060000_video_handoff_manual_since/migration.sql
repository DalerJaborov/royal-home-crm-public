-- Ручное ожидание готового ролика не занимает место монтажёра (23.09.2026).
ALTER TABLE "Property" ADD COLUMN "videoHandoffManualSince" TIMESTAMP(3);
