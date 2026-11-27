-- Additive only (28.11.2026): switch «Короткие сообщения монтажёру», ON by default (owner decision).
ALTER TABLE "Settings" ADD COLUMN "montajerShortMessages" BOOLEAN NOT NULL DEFAULT true;
