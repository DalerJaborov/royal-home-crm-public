-- 28.09.2026: машина + сильное желание = зелёный (Нурмухаммад, подтверждено Dan);
-- достижения — для резюме кандидата на экране вакансий.
ALTER TABLE "JobApplication" ADD COLUMN IF NOT EXISTS "strongMotivation" BOOLEAN;
ALTER TABLE "JobApplication" ADD COLUMN IF NOT EXISTS "achievements" TEXT;
