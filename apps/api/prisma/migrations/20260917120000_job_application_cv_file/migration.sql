-- Файл резюме кандидата: ссылка на уже сохранённое вложение переписки
-- (lib/privateFiles.ts), не новое хранилище.
ALTER TABLE "JobApplication" ADD COLUMN "cvFile" TEXT;
