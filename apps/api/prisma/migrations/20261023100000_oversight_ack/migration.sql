-- Additive only: new table, no existing data touched.
CREATE TABLE "OversightAck" (
  "id" TEXT NOT NULL,
  "sliceKey" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "ackedById" TEXT NOT NULL,
  "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" VARCHAR(500),
  CONSTRAINT "OversightAck_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OversightAck_sliceKey_subjectId_key" ON "OversightAck"("sliceKey", "subjectId");
CREATE INDEX "OversightAck_ackedById_idx" ON "OversightAck"("ackedById");
ALTER TABLE "OversightAck" ADD CONSTRAINT "OversightAck_ackedById_fkey" FOREIGN KEY ("ackedById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
