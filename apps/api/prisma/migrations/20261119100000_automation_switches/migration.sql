-- Выключатели «Автоматика ИИ и напоминания» (владелец 19.11.2026). Все true: выкат поведение не меняет.
ALTER TABLE "Settings" ADD COLUMN "aiCardFromCallEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "aiAgentShowingAutoBookEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "aiJobSeekerAutoDetachEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "dealStaleBuyersEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "notifyClientWaitingEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "notifyRobotTookCallEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "notifyTrashAnomalyEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "notifyPropertyReviewOverdueEnabled" BOOLEAN NOT NULL DEFAULT true;
