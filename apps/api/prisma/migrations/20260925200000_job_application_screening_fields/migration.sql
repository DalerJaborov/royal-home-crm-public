-- Отбор кандидатов: два явных да/нет поля модели вместо её собственного мнения
-- о цвете светофора (25.09.2026, разбор жалобы «в зелёных стоят электрики»).
-- Аддитивно, nullable — старые анкеты просто не знают ответа (null), пересчёт
-- цвета по ним делает lib/rescoreJobApplications.ts.
-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "salesExperience" BOOLEAN,
ADD COLUMN     "targetEducation" BOOLEAN;
