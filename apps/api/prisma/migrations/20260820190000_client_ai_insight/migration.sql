-- Короткая сводка «что с клиентом происходит» и время её сборки.
-- Обе колонки nullable: у клиентов, заведённых до этой правки, сводки ещё нет,
-- и карточка обязана уметь показывать карточку без неё.
ALTER TABLE "Client" ADD COLUMN "aiInsight" TEXT;
ALTER TABLE "Client" ADD COLUMN "aiInsightAt" TIMESTAMP(3);
