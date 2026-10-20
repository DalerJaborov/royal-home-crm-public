-- PostgreSQL CHECK accepts NULL. Require the nullable additive managed fields
-- explicitly when a managed resource/receipt is present, without touching
-- legacy rows or interpreting a local receipt as provider delivery.
ALTER TABLE "CustomerAction" ADD CONSTRAINT "CustomerAction_receipt_required_check" CHECK
  ("status" <> 'COMMITTED' OR ("receiptVersion" IS NOT NULL AND "resourceType" IS NOT NULL AND
    ("receiptVersion" <> 2 OR ("publicRef" IS NOT NULL AND "resourceRevision" IS NOT NULL))));
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_managed_fields_required_check" CHECK
  ("customerActionId" IS NULL OR ("requestKind" IS NOT NULL AND "lifecycleStatus" IS NOT NULL AND "lifecycleRevision" IS NOT NULL));
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_managed_revision_required_check" CHECK
  ("customerBookingActionId" IS NULL OR "managedShowingRevision" IS NOT NULL);
ALTER TABLE "OwnerQuestion" ADD CONSTRAINT "OwnerQuestion_managed_fields_required_check" CHECK
  ("customerActionId" IS NULL OR ("managedRevision" IS NOT NULL AND "deliveryStatus" IS NOT NULL));
