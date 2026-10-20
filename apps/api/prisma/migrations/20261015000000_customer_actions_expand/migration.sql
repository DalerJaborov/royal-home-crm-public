-- Additive customer-actions resources. All capabilities remain OFF. Historical
-- migrations and committed receipt V1 keep their meaning.
ALTER TABLE "CustomerAction" ADD COLUMN "publicRef" TEXT, ADD COLUMN "resourceRevision" BIGINT;
CREATE UNIQUE INDEX "CustomerAction_publicRef_key" ON "CustomerAction"("publicRef");
ALTER TABLE "CustomerAction" DROP CONSTRAINT "CustomerAction_kind_check", DROP CONSTRAINT "CustomerAction_committed_check";
ALTER TABLE "CustomerAction" ADD CONSTRAINT "CustomerAction_kind_check" CHECK
  ("kind" IN ('contact','callback','new_lead','handover','book_showing','reschedule_showing','cancel_showing','owner_question'));
ALTER TABLE "CustomerAction" ADD CONSTRAINT "CustomerAction_committed_check" CHECK ("status" <> 'COMMITTED' OR
  ("committedAt" IS NOT NULL AND "resourceId" IS NOT NULL AND length("resourceId") > 0 AND
   (("receiptVersion" = 1 AND (("kind"='contact' AND "resourceType"='CustomerInquiry' AND "resourceId"="inquiryId") OR
      ("kind"='callback' AND "resourceType"='CallbackRequest') OR ("kind"='new_lead' AND "resourceType"='Client'))) OR
    ("receiptVersion" = 2 AND "publicRef" IS NOT NULL AND "resourceRevision" > 0 AND
      (("kind"='handover' AND "resourceType"='CallbackRequest') OR
       ("kind" IN ('book_showing','reschedule_showing','cancel_showing') AND "resourceType"='Interaction') OR
       ("kind"='owner_question' AND "resourceType"='OwnerQuestion'))))));

ALTER TABLE "CallbackRequest" ADD COLUMN "requestKind" TEXT, ADD COLUMN "lifecycleStatus" TEXT,
  ADD COLUMN "lifecycleRevision" BIGINT, ADD COLUMN "assignedAgentId" TEXT, ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "closureReason" TEXT, ADD COLUMN "handoverFence" JSONB;
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_assignedAgentId_fkey"
  FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE "CallbackRequest" SET "requestKind"='CALLBACK', "lifecycleRevision"=1,
  "lifecycleStatus"=CASE WHEN "doneAt" IS NULL THEN 'QUEUED' ELSE 'CLOSED' END,
  "closureReason"=CASE WHEN "doneAt" IS NULL THEN NULL ELSE 'legacy_closed' END
  WHERE "customerActionId" IS NOT NULL;
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_managed_lifecycle_check" CHECK
  ("customerActionId" IS NULL OR ("requestKind" IN ('CALLBACK','HUMAN') AND "lifecycleRevision">0 AND
    "lifecycleStatus" IN ('QUEUED','ACCEPTED','CLOSED') AND
    ("lifecycleStatus" <> 'ACCEPTED' OR ("assignedAgentId" IS NOT NULL AND "acceptedAt" IS NOT NULL)) AND
    (("lifecycleStatus"='CLOSED') = ("doneAt" IS NOT NULL))));

ALTER TABLE "Interaction" ADD COLUMN "customerBookingActionId" TEXT, ADD COLUMN "managedShowingRevision" BIGINT;
CREATE UNIQUE INDEX "Interaction_customerBookingActionId_key" ON "Interaction"("customerBookingActionId");
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_customerBookingActionId_fkey"
  FOREIGN KEY ("customerBookingActionId") REFERENCES "CustomerAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_managed_showing_check" CHECK
  (("customerBookingActionId" IS NULL AND "managedShowingRevision" IS NULL) OR
   ("customerBookingActionId" IS NOT NULL AND "managedShowingRevision">0));

ALTER TABLE "OwnerQuestion" ADD COLUMN "customerActionId" TEXT, ADD COLUMN "replyTarget" JSONB,
  ADD COLUMN "managedRevision" BIGINT, ADD COLUMN "deliveryStatus" TEXT;
CREATE UNIQUE INDEX "OwnerQuestion_customerActionId_key" ON "OwnerQuestion"("customerActionId");
ALTER TABLE "OwnerQuestion" ADD CONSTRAINT "OwnerQuestion_customerActionId_fkey"
  FOREIGN KEY ("customerActionId") REFERENCES "CustomerAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerQuestion" ADD CONSTRAINT "OwnerQuestion_managed_check" CHECK
  ("customerActionId" IS NULL OR ("managedRevision">0 AND "replyTarget" IS NOT NULL AND
    jsonb_typeof("replyTarget")='object' AND "deliveryStatus" IN ('QUEUED','HELD','ACCEPTED','UNKNOWN','FAILED')));

CREATE OR REPLACE FUNCTION customer_action_committed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"='COMMITTED' AND
    ROW(NEW."status",NEW."inquiryId",NEW."kind",NEW."generation",NEW."stateRevision",NEW."intentRevision",NEW."ownershipEpoch",NEW."bindingRevision",NEW."scopeRevision",NEW."policyRevision",NEW."evidenceRefs",NEW."resourceType",NEW."resourceId",NEW."receiptVersion",NEW."committedAt",NEW."publicRef",NEW."resourceRevision") IS DISTINCT FROM
    ROW(OLD."status",OLD."inquiryId",OLD."kind",OLD."generation",OLD."stateRevision",OLD."intentRevision",OLD."ownershipEpoch",OLD."bindingRevision",OLD."scopeRevision",OLD."policyRevision",OLD."evidenceRefs",OLD."resourceType",OLD."resourceId",OLD."receiptVersion",OLD."committedAt",OLD."publicRef",OLD."resourceRevision") THEN
    RAISE EXCEPTION 'committed customer resource receipt is immutable';
  END IF;
  RETURN NEW;
END $$;

-- Staff and legacy writers participate in the same revision. Moving away and
-- back to the old date/assignee must not revive a customer's stale proposal.
CREATE FUNCTION customer_managed_showing_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."customerBookingActionId" IS NOT NULL THEN
    IF NEW."customerBookingActionId" IS DISTINCT FROM OLD."customerBookingActionId" OR NEW."clientId" <> OLD."clientId" THEN
      RAISE EXCEPTION 'customer booking origin is immutable';
    END IF;
    IF ROW(NEW."propertyId",NEW."nextActionDate",NEW."nextAction",NEW."completedAt",NEW."outcome",NEW."subjectAgentId",NEW."agentId",NEW."type") IS DISTINCT FROM
       ROW(OLD."propertyId",OLD."nextActionDate",OLD."nextAction",OLD."completedAt",OLD."outcome",OLD."subjectAgentId",OLD."agentId",OLD."type") THEN
      NEW."managedShowingRevision" := OLD."managedShowingRevision"+1;
    ELSE
      NEW."managedShowingRevision" := OLD."managedShowingRevision";
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_managed_showing_revision BEFORE UPDATE ON "Interaction"
  FOR EACH ROW EXECUTE FUNCTION customer_managed_showing_revision();

CREATE FUNCTION customer_owner_question_target_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."customerActionId" IS NOT NULL AND
    ROW(NEW."customerActionId",NEW."replyTarget",NEW."conversationId",NEW."clientId",NEW."propertyId",NEW."question") IS DISTINCT FROM
    ROW(OLD."customerActionId",OLD."replyTarget",OLD."conversationId",OLD."clientId",OLD."propertyId",OLD."question") THEN
    RAISE EXCEPTION 'customer owner-question origin is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_owner_question_target_immutable BEFORE UPDATE ON "OwnerQuestion"
  FOR EACH ROW EXECUTE FUNCTION customer_owner_question_target_immutable();
