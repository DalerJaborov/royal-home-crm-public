-- Additive only (12.11.2026): last narration voice/template chosen by each staff member.
ALTER TABLE "Agent" ADD COLUMN "narrationLastChoice" JSONB;
