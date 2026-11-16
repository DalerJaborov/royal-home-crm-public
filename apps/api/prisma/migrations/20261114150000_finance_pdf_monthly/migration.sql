-- PDF финансового отчёта директорам раз в месяц (14.11.2026): выключатель и отметка разосланного месяца.
ALTER TABLE "Settings" ADD COLUMN "financePdfMonthlyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "financePdfMonthlyLastSent" TEXT;
