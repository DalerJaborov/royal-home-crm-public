-- Сроки и состояние объявления: когда создано, когда идёт показ, активно ли сейчас
-- и какая была цель. Отчёт до этого показывал расход, не отвечая «за какой период».
ALTER TABLE "Ad" ADD COLUMN "createdTime" TIMESTAMP(3);
ALTER TABLE "Ad" ADD COLUMN "startTime" TIMESTAMP(3);
ALTER TABLE "Ad" ADD COLUMN "stopTime" TIMESTAMP(3);
ALTER TABLE "Ad" ADD COLUMN "status" TEXT;
ALTER TABLE "Ad" ADD COLUMN "objective" TEXT;
