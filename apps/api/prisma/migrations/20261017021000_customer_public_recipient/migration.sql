-- Native private-reply recipient binding, never a phone/username identity guess.
ALTER TABLE "CustomerPublicEffect" ADD COLUMN "recipientKey" text;
ALTER TABLE "CustomerPublicEffect" ADD CONSTRAINT "CustomerPublicEffect_recipient_check"
  CHECK ("recipientKey" IS NULL OR ("kind"='private_reply' AND "status"='ACCEPTED'
    AND "providerId" IS NOT NULL AND "recipientKey" ~ '^[a-f0-9]{64}$'));
CREATE INDEX "CustomerPublicEffect_recipientKey_createdAt_idx" ON "CustomerPublicEffect"("recipientKey","createdAt");
-- The existing immutable trigger freezes EVERY terminal row including new columns.
