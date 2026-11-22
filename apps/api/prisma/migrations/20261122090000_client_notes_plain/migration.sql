-- «Заметки» без служебных ярлыков бота — для подсказки «Может, один человек?» (PR #382).
-- Только новые колонки и индекс: существующие данные не меняются. Заполняет их перехват
-- записи в db.ts (новые записи) и обход при старте worker (lib/clientNotesPlainSweep.ts) —
-- очистка считается кодом из одного списка ярлыков (lib/clientNoteLabels.ts), не SQL.
ALTER TABLE "Client" ADD COLUMN "requirementsNotesPlain" TEXT;
ALTER TABLE "Client" ADD COLUMN "requirementsNotesPlainRev" INTEGER;

CREATE INDEX "Client_requirementsNotesPlain_trgm_idx" ON "Client" USING GIN ("requirementsNotesPlain" gin_trgm_ops);
