-- Optional binding lets future buyer reminders reuse the existing guarded task state machine.
-- Historical previews remain unbound and are never promoted.
ALTER TABLE "SellerControlEpisode" ADD COLUMN "buyerCandidateId" TEXT;
CREATE UNIQUE INDEX "SellerControlEpisode_buyerCandidateId_key" ON "SellerControlEpisode"("buyerCandidateId");
