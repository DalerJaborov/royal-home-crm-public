-- Change stamp for optimistic writes; it is metadata, not a historical event time.
ALTER TABLE "Client" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
