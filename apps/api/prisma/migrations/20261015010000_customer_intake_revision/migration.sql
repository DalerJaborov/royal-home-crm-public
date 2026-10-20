-- RAW intake selects a brain before legacy/worker ownership can race. This
-- field grants no customer/model/outbound rights. Existing FINAL-only triad
-- checks from506 remain unchanged. NULL historical choices are never upgraded.
ALTER TABLE "CustomerPropertyIngressTicket" ADD COLUMN "intakeAgentRevisionId" TEXT;
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerIngress_intake_revision_fkey"
  FOREIGN KEY ("intakeAgentRevisionId") REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerIngress_intake_revision_check" CHECK (
  "intakeAgentRevisionId" IS NULL OR
  ("intakeAgentRevisionId" ~ '^[a-f0-9]{64}$' AND
    ("agentRevisionId" IS NULL OR "agentRevisionId"="intakeAgentRevisionId"))
);
CREATE FUNCTION customer_intake_agent_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."intakeAgentRevisionId" IS DISTINCT FROM OLD."intakeAgentRevisionId" THEN
    RAISE EXCEPTION 'original intake brain selection cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_intake_agent_revision_immutable BEFORE UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_intake_agent_revision_immutable();
