-- Existing rows remain unknown: a later role change cannot prove a past role.
ALTER TABLE "Interaction" ADD COLUMN "buyerIntentAtCreation" BOOLEAN;
