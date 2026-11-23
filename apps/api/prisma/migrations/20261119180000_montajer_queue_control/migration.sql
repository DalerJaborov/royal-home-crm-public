-- Additive only (19.11.2026): switch «Монтажёр управляет очередью из бота», ON by default (owner request).
ALTER TABLE "Settings" ADD COLUMN "montajerQueueControlEnabled" BOOLEAN NOT NULL DEFAULT true;
