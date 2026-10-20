-- Расстановка публикаций по времени: управление из Настроек и причина слота в карточке.
ALTER TABLE "Settings" ADD COLUMN "publishScheduleEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "publishScheduleUseHeatmap" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "publishScheduleWindowStartMin" INTEGER NOT NULL DEFAULT 540;
ALTER TABLE "Settings" ADD COLUMN "publishScheduleWindowEndMin" INTEGER NOT NULL DEFAULT 1260;
ALTER TABLE "Settings" ADD COLUMN "publishScheduleMinGapMin" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Settings" ADD COLUMN "publishSchedulePriorityWindows" INTEGER[] NOT NULL DEFAULT ARRAY[720, 840, 1140, 1260];
ALTER TABLE "Settings" ADD COLUMN "publishScheduleHeatmapDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Settings" ADD COLUMN "publishScheduleLeadHours" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Property" ADD COLUMN "scheduledPublishReason" TEXT;
