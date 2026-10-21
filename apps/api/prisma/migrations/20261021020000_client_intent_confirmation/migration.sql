ALTER TABLE "Client" ADD COLUMN "dualIntentConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "dualIntentConfirmedById" TEXT;

ALTER TABLE "Client" ADD CONSTRAINT "Client_dualIntentConfirmedById_fkey"
  FOREIGN KEY ("dualIntentConfirmedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
