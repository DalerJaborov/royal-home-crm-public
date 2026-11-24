-- Автопамять подключённых групп Шабнам (25.11.2026), ВКЛ. Только новая колонка.
ALTER TABLE "Settings" ADD COLUMN "shabnamGroupAutoMemoryEnabled" BOOLEAN NOT NULL DEFAULT true;
