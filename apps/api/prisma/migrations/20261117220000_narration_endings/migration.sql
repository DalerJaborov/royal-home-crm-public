-- Additive only (16.11.2026). The ending chosen for a narration version is stored with it, so the text is rebuilt the same way later.
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "endingId" TEXT;
