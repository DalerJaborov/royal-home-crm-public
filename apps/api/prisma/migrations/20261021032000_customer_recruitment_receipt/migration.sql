ALTER TABLE "JobApplication" ADD COLUMN "customerInquiryId" TEXT,
  ADD COLUMN "customerPositionKey" TEXT, ADD COLUMN "customerApplicationRevision" BIGINT,
  ADD COLUMN "customerPortfolio" JSONB;
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_customerInquiryId_fkey"
  FOREIGN KEY ("customerInquiryId") REFERENCES "CustomerInquiry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_customerPositionKey_fkey"
  FOREIGN KEY ("customerPositionKey") REFERENCES "RecruitmentPosition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "JobApplication_customerInquiryId_customerPositionKey_key"
  ON "JobApplication"("customerInquiryId","customerPositionKey");
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_customer_source_check" CHECK
  (("customerInquiryId" IS NULL AND "customerPositionKey" IS NULL AND "customerApplicationRevision" IS NULL)
    OR ("customerInquiryId" IS NOT NULL AND "customerPositionKey" IS NOT NULL AND "customerApplicationRevision">0));
ALTER TABLE "CustomerAction" DROP CONSTRAINT "CustomerAction_kind_check", DROP CONSTRAINT "CustomerAction_committed_check";
ALTER TABLE "CustomerAction" ADD CONSTRAINT "CustomerAction_kind_check" CHECK
  ("kind" IN ('contact','callback','new_lead','handover','book_showing','reschedule_showing','cancel_showing','owner_question','job_application'));
ALTER TABLE "CustomerAction" ADD CONSTRAINT "CustomerAction_committed_check" CHECK ("status" <> 'COMMITTED' OR
  ("committedAt" IS NOT NULL AND "resourceId" IS NOT NULL AND length("resourceId") > 0 AND
   (("receiptVersion" = 1 AND (("kind"='contact' AND "resourceType"='CustomerInquiry' AND "resourceId"="inquiryId") OR
      ("kind"='callback' AND "resourceType"='CallbackRequest') OR ("kind"='new_lead' AND "resourceType"='Client'))) OR
    ("receiptVersion" = 2 AND "publicRef" IS NOT NULL AND "resourceRevision" > 0 AND
      (("kind"='handover' AND "resourceType"='CallbackRequest') OR
       ("kind" IN ('book_showing','reschedule_showing','cancel_showing') AND "resourceType"='Interaction') OR
       ("kind"='owner_question' AND "resourceType"='OwnerQuestion') OR
       ("kind"='job_application' AND "resourceType"='JobApplication'))))));
