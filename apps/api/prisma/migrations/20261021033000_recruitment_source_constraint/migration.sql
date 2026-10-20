-- CHECK accepts UNKNOWN, so a positive managed revision must also be explicitly
-- non-NULL. Keep historical all-NULL sources valid. Applied prior migrations
-- remain unchanged; inconsistent existing data fails validation instead of
-- being silently rewritten or deleted.
ALTER TABLE "JobApplication"
  DROP CONSTRAINT "JobApplication_customer_source_check",
  ADD CONSTRAINT "JobApplication_customer_source_check" CHECK (
    ("customerInquiryId" IS NULL AND "customerPositionKey" IS NULL AND "customerApplicationRevision" IS NULL)
    OR ("customerInquiryId" IS NOT NULL AND "customerPositionKey" IS NOT NULL
      AND "customerApplicationRevision" IS NOT NULL AND "customerApplicationRevision" > 0)
  );
